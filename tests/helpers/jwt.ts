/**
 * Test-side JWT mint helpers.
 *
 * Shared by every test tier (unit, integration, e2e). **PROD CODE MUST
 * NOT IMPORT FROM `tests/`.** The `prod-never-imports-tests` rule in
 * `.dependency-cruiser.cjs` enforces it, and the Nuxt server bundle
 * never includes `tests/*` (no route imports from here).
 *
 * Why this module exists: the `aiDictateWs scope-mismatch` incident.
 * The test mint helper for dictate-tokens drifted from the prod mint
 * shape: test set `{ kind: 'dictate' }`, prod additionally required
 * `scope: 'dictate'`. The verifier rejected with 4001 'scope mismatch'
 * BEFORE any of the actual logic under test could fire — nine tests
 * silently failed for the wrong reason. Routing every test mint
 * through these helpers, which spread the same `*_FIXED_CLAIMS`
 * constants the prod mint sites use, makes that drift impossible.
 *
 * Each helper takes:
 *   - The **payload contents** (the variable parts — userId, docId, …).
 *     Typed against the shared contract so missing fields error at
 *     compile time.
 *   - An **opts** object with `secret` (required) + optional `ttl`.
 *     Secrets stay in test fixtures (`tests/integration/setup/env.ts`)
 *     since they vary by test environment; the helper is shape-safe,
 *     not env-aware.
 *
 * For ADVERSARIAL test cases that deliberately mint malformed tokens
 * (e.g. `printPage.test.ts` testing scope-mismatch rejection,
 * `renderTokens.test.ts` testing wrong-secret rejection, etc.), keep
 * calling `jwt.sign` directly. The helpers here are for the
 * happy-path mint — using them for adversarial mints would defeat
 * the contract guarantee.
 */

import jwt from 'jsonwebtoken'
import {
  DICTATE_JWT_FIXED_CLAIMS,
  RENDER_JWT_FIXED_CLAIMS,
  type DictateJwtPayload,
  type RenderJwtPayload,
  type SessionJwtPayload
} from '~~/shared/contracts/jwt'

interface BaseOpts {
  secret: string
  /** seconds, '60s', '2h', etc — passed through to jsonwebtoken */
  ttl?: jwt.SignOptions['expiresIn']
}

/**
 * Mint a Hocuspocus session token. Matches the shape minted by
 * `server/api/docs/[docId]/token.get.ts`, `aiClient.ts`, `restoreDoc.ts`,
 * `commentsServerClient.ts`. The verifier in `sync-server/src/auth.ts`
 * accepts these for ANY of those producer roles — they're
 * indistinguishable on the wire (intentional; the userId convention
 * encodes the principal type).
 *
 * Default TTL is 2h, matching the doc-token endpoint. Override for
 * tests that need to exercise expiry behaviour.
 */
export function mintSessionJwt(
  claims: SessionJwtPayload,
  opts: BaseOpts
): string {
  return jwt.sign(claims, opts.secret, { expiresIn: opts.ttl ?? '2h' })
}

/**
 * Mint a dictate WS token. Matches the shape minted by
 * `server/api/ai/dictate/token.post.ts` — `kind` AND `scope` are both
 * spread from `DICTATE_JWT_FIXED_CLAIMS`, so callers cannot forget
 * either field. (Forgetting `scope` is exactly what triggered the
 * incident this whole module exists to prevent.)
 *
 * Default TTL is 60s, matching the prod mint. Override for expiry
 * tests.
 */
export function mintDictateJwt(
  claims: { userId: number, docId: string },
  opts: BaseOpts
): string {
  const payload = {
    ...claims,
    ...DICTATE_JWT_FIXED_CLAIMS
  } satisfies DictateJwtPayload
  return jwt.sign(payload, opts.secret, { expiresIn: opts.ttl ?? '60s' })
}

/**
 * Mint a render token. Matches the shape minted by
 * `server/utils/renderTokens.ts` AND `renderer/src/render.ts`. The
 * `scope` claim comes from `RENDER_JWT_FIXED_CLAIMS` so callers
 * cannot drift.
 *
 * Default TTL is 60s, matching prod. The render-token integration
 * tests exercise expiry / wrong-scope / wrong-secret cases; those
 * tests should call `jwt.sign` directly to construct the malformed
 * variant rather than threading a `scope?: string` override through
 * here (keeps the contract guarantee crisp: this helper ALWAYS
 * produces a valid render token).
 */
export function mintRenderJwt(
  claims: { docId: string, snapshotId: number },
  opts: BaseOpts
): string {
  const payload = {
    ...claims,
    ...RENDER_JWT_FIXED_CLAIMS
  } satisfies RenderJwtPayload
  return jwt.sign(payload, opts.secret, { expiresIn: opts.ttl ?? 60 })
}
