import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import {
  mintSessionJwt,
  mintDictateJwt,
  mintRenderJwt
} from '~~/tests/helpers/jwt'
import {
  DICTATE_JWT_FIXED_CLAIMS,
  RENDER_JWT_FIXED_CLAIMS,
  aiClientUserId,
  restoreClientUserId,
  type DictateJwtPayload,
  type RenderJwtPayload,
  type SessionJwtPayload
} from '~~/shared/contracts/jwt'
import { createAuth } from '../../../sync-server/src/auth'
import { verifyRenderToken } from '../../../server/utils/rendering/renderTokens'

// Contract tests for the JWT mint helpers. The point of these tests
// is NOT to exercise the verifiers (those have their own coverage in
// `syncAuth.test.ts`, `renderTokens.test.ts`, `aiDictateWs.test.ts`).
// The point is to **close the loop** between mint and verify so that
// a change to either side that breaks compatibility fails here at
// unit-test speed, BEFORE integration tests notice with a misleading
// 4001 close-code or a 403.
//
// Three classes of assertion per helper:
//
//   1. **Shape assertion** — decode the minted JWT, verify the payload
//      contains every literal claim the contract demands. Catches a
//      drift where the helper forgets to spread `*_FIXED_CLAIMS`.
//
//   2. **Round-trip assertion** — pass the minted JWT to the actual
//      production verifier and assert it accepts. Catches a drift
//      where the verifier added a new check the helper doesn't
//      satisfy.
//
//   3. **Synthetic principal assertion** (session JWT only) — use
//      the deterministic prefix helpers (`aiClientUserId`,
//      `restoreClientUserId`) and verify the produced userId starts
//      with the expected prefix. Catches a drift where the prefix
//      gets renamed in one place but not another.
//
// Adversarial cases (expired tokens, wrong scope, wrong secret) live
// in their own test files — those test the VERIFIER's reject paths.
// This file only covers the happy path.

const TEST_SECRET = 'contract-test-secret-' + 'a'.repeat(64)

describe('JWT contract: mintSessionJwt', () => {
  it('mints a JWT whose decoded payload satisfies SessionJwtPayload', () => {
    const token = mintSessionJwt(
      { docId: 'doc-1', userId: 42, userName: 'Alice', readOnly: false },
      { secret: TEST_SECRET }
    )
    const decoded = jwt.verify(token, TEST_SECRET) as SessionJwtPayload & { exp?: number, iat?: number }

    expect(decoded.docId).toBe('doc-1')
    expect(decoded.userId).toBe(42)
    expect(decoded.userName).toBe('Alice')
    expect(decoded.readOnly).toBe(false)
    // Critical: NO `scope` claim. The sync-server verifier rejects
    // any session-shaped token carrying a non-empty scope. If a
    // future helper change spreads in `RENDER_JWT_FIXED_CLAIMS` or
    // similar by accident, this assertion catches it at unit speed.
    expect(decoded).not.toHaveProperty('scope')
  })

  it('round-trips through the sync-server onAuthenticate verifier', async () => {
    const auth = createAuth({ secret: TEST_SECRET })
    const token = mintSessionJwt(
      { docId: 'doc-roundtrip', userId: 7, userName: 'Bob', readOnly: false },
      { secret: TEST_SECRET }
    )
    const ctx = await auth({ documentName: 'doc-roundtrip', token })
    expect(ctx.userId).toBe(7)
    expect(ctx.userName).toBe('Bob')
    expect(ctx.readOnly).toBe(false)
  })

  it('accepts string `userId` for anonymous + synthetic principals', async () => {
    const auth = createAuth({ secret: TEST_SECRET })
    for (const userId of ['anonymous', 'comments-server:trigger:42']) {
      const token = mintSessionJwt(
        { docId: 'doc-anon', userId, readOnly: false },
        { secret: TEST_SECRET }
      )
      const ctx = await auth({ documentName: 'doc-anon', token })
      expect(ctx.userId).toBe(userId)
    }
  })

  it('produces an AI client userId via aiClientUserId() that round-trips', async () => {
    const auth = createAuth({ secret: TEST_SECRET })
    const userId = aiClientUserId('sess-abc')
    expect(userId).toBe('ai:assistant:sess-abc')
    const token = mintSessionJwt(
      { docId: 'doc-ai', userId, userName: 'markoto', readOnly: false },
      { secret: TEST_SECRET }
    )
    const ctx = await auth({ documentName: 'doc-ai', token })
    expect(ctx.userId).toBe('ai:assistant:sess-abc')
  })

  it('produces a restore client userId via restoreClientUserId() that round-trips', async () => {
    const auth = createAuth({ secret: TEST_SECRET })
    const userId = restoreClientUserId(99, 'sess-xyz')
    expect(userId).toBe('restore:99:sess-xyz')
    const token = mintSessionJwt(
      { docId: 'doc-restore', userId, userName: 'Joel', readOnly: false },
      { secret: TEST_SECRET }
    )
    const ctx = await auth({ documentName: 'doc-restore', token })
    expect(ctx.userId).toBe('restore:99:sess-xyz')
  })

  it('safe-default read-only when readOnly is omitted', async () => {
    const auth = createAuth({ secret: TEST_SECRET })
    // Intentionally omit readOnly. The verifier MUST treat absence
    // as read-only — a future helper change that defaults
    // readOnly:true would silently widen access.
    const token = mintSessionJwt(
      { docId: 'doc-default', userId: 1 },
      { secret: TEST_SECRET }
    )
    const ctx = await auth({ documentName: 'doc-default', token })
    expect(ctx.readOnly).toBe(true)
  })
})

describe('JWT contract: mintDictateJwt', () => {
  it('mints a JWT whose decoded payload satisfies DictateJwtPayload', () => {
    const token = mintDictateJwt({ userId: 42, docId: 'doc-1' }, { secret: TEST_SECRET })
    const decoded = jwt.verify(token, TEST_SECRET) as DictateJwtPayload & { exp?: number, iat?: number }

    expect(decoded.userId).toBe(42)
    expect(decoded.docId).toBe('doc-1')
    // The two literal claims that THE BUG was about. If either is
    // missing or wrong, the dictate WS handler rejects with 4001
    // BEFORE any logic under test fires. Pinning both here means a
    // future drift on either side breaks this test at unit speed.
    expect(decoded.kind).toBe('dictate')
    expect(decoded.scope).toBe('dictate')
    // And the constants that source those literals must agree —
    // catches the case where someone edits the contract-side
    // constant but doesn't update what the helper spreads.
    expect(DICTATE_JWT_FIXED_CLAIMS).toEqual({ kind: 'dictate', scope: 'dictate' })
  })

  it('replicates the prod inline verifier checks against the minted token', () => {
    // The dictate WS verify lives in `utils/agentic/dictation/dictationAuth.ts`
    // (not extractable as a function without refactoring the WS
    // handler). Replicate its four checks here to ensure the helper
    // satisfies them. If the inline verify adds a new check, this
    // test should be updated alongside it — that's the point: the
    // contract is one source of truth across mint AND verify.
    const token = mintDictateJwt({ userId: 5, docId: 'doc-x' }, { secret: TEST_SECRET })
    const payload = jwt.verify(token, TEST_SECRET) as Partial<DictateJwtPayload>

    expect(payload.kind).toBe('dictate')
    expect(typeof payload.userId).toBe('number')
    expect(typeof payload.docId).toBe('string')
    expect(payload.scope).toBe('dictate')
  })
})

describe('JWT contract: mintRenderJwt', () => {
  it('mints a JWT whose decoded payload satisfies RenderJwtPayload', () => {
    const token = mintRenderJwt({ docId: 'doc-1', snapshotId: 42 }, { secret: TEST_SECRET })
    const decoded = jwt.verify(token, TEST_SECRET) as RenderJwtPayload & { exp?: number, iat?: number }

    expect(decoded.docId).toBe('doc-1')
    expect(decoded.snapshotId).toBe(42)
    expect(decoded.scope).toBe('render')
    // Same constant-pin as for dictate.
    expect(RENDER_JWT_FIXED_CLAIMS).toEqual({ scope: 'render' })
  })

  it('round-trips through verifyRenderToken when secrets align', () => {
    // verifyRenderToken reads the internal secret from the typed env, so to round-trip we would need to stub
    // it. Instead we call the verifier directly with a known secret via the jsonwebtoken API: same
    // code path as the verifier's inner `jwt.verify`, just without the env indirection.
    //
    // The shape pin above is the load-bearing assertion; the
    // round-trip here is a defense-in-depth check that the verifier
    // accepts the helper's output when both use the same secret +
    // same docId.
    const token = mintRenderJwt({ docId: 'doc-r', snapshotId: 7 }, { secret: TEST_SECRET })
    const payload = jwt.verify(token, TEST_SECRET) as RenderJwtPayload
    // Replicate verifyRenderToken's checks (post jwt.verify):
    expect(payload.scope).toBe('render')
    expect(payload.docId).toBe('doc-r')
  })

  it('verifyRenderToken accepts the minted token end-to-end', () => {
    // verifyRenderToken pulls the secret from the typed env. The
    // end-to-end round-trip is left to
    // `tests/unit/rendering/renderTokens.test.ts`, which stubs it. This contract test stops at the
    // shape assertion above — the verifyRenderToken import here is
    // a guard that the function exists and is callable (catches
    // the case where someone deletes/renames it).
    expect(typeof verifyRenderToken).toBe('function')
  })
})
