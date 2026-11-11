import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { createAuth, createTokenVerifier, type DocJwtPayload } from '../../../sync-server/src/auth'

// Sync-server `onAuthenticate` hook — the second line of defence for every
// Y.js WebSocket connection. If this ever accepts a token it shouldn't,
// every other layer of authz becomes advisory.
//
// Every branch in the analysis table is pinned here. Cases labelled
// "critical" are the ones where a regression silently opens a security
// hole — no error, no log, just access granted.

const SECRET = 'test-secret-' + 'a'.repeat(64)
const PREVIOUS_SECRET = 'previous-secret-' + 'b'.repeat(64)
const OTHER_SECRET = 'unrelated-secret-' + 'c'.repeat(64)

const auth = createAuth({ secret: SECRET })
const authWithRotation = createAuth({ secret: SECRET, previousSecret: PREVIOUS_SECRET })

function sign(payload: Partial<DocJwtPayload>, opts: jwt.SignOptions = {}, secret = SECRET): string {
  return jwt.sign(payload, secret, { expiresIn: '2h', ...opts })
}

describe('createAuth / onAuthenticate', () => {
  describe('token presence', () => {
    it('rejects null token (Authentication required)', async () => {
      await expect(auth({ documentName: 'doc-1', token: null }))
        .rejects.toThrow('Authentication required')
    })

    it('rejects empty-string token (Authentication required)', async () => {
      await expect(auth({ documentName: 'doc-1', token: '' }))
        .rejects.toThrow('Authentication required')
    })
  })

  describe('happy path', () => {
    it('accepts a valid token and returns the auth context', async () => {
      const token = sign({ docId: 'doc-1', userId: 42, userName: 'Alice', readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      const { exp } = jwt.decode(token) as { exp: number }
      expect(ctx).toEqual({
        readOnly: false,
        userId: 42,
        userName: 'Alice',
        // The connection is closed at this moment unless renewed.
        tokenExpiresAt: exp * 1000
      })
    })

    it('accepts anonymous sentinel userId', async () => {
      const token = sign({ docId: 'doc-1', userId: 'anonymous', userName: null, readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.userId).toBe('anonymous')
    })

    it('accepts number-valued userId (matches token endpoint shape)', async () => {
      // Regression guard for the TS declaration: userId can be number or
      // string, and we must not drop/coerce the number variant.
      const token = sign({ docId: 'doc-1', userId: 42, userName: 'Alice', readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(typeof ctx.userId).toBe('number')
      expect(ctx.userId).toBe(42)
    })
  })

  describe('scope check (critical — cross-doc replay guard)', () => {
    it('rejects when docId claim does not match documentName', async () => {
      const token = sign({ docId: 'doc-A', userId: 1, readOnly: false })
      await expect(auth({ documentName: 'doc-B', token }))
        .rejects.toThrow('Token scope mismatch')
    })

    it('rejects when docId claim is missing entirely', async () => {
      // Implicit: missing docId → undefined !== 'doc-1' → scope mismatch.
      const token = sign({ userId: 1, readOnly: false })
      await expect(auth({ documentName: 'doc-1', token }))
        .rejects.toThrow('Token scope mismatch')
    })

    it('enforces exact string equality (no prefix / substring match)', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      // Sanity: substring-matching would be a disaster.
      await expect(auth({ documentName: 'doc-11', token }))
        .rejects.toThrow('Token scope mismatch')
      await expect(auth({ documentName: 'doc-', token }))
        .rejects.toThrow('Token scope mismatch')
    })
  })

  describe('signature / expiry', () => {
    it('rejects token signed with a different secret', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false }, {}, OTHER_SECRET)
      await expect(auth({ documentName: 'doc-1', token }))
        .rejects.toThrow('Invalid token')
    })

    it('rejects expired token', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false }, { expiresIn: '-1s' })
      await expect(auth({ documentName: 'doc-1', token }))
        .rejects.toThrow('Invalid token')
    })

    it('rejects malformed token (not a JWT at all)', async () => {
      await expect(auth({ documentName: 'doc-1', token: 'not.a.jwt' }))
        .rejects.toThrow('Invalid token')
    })

    it('rejects random string as token', async () => {
      await expect(auth({ documentName: 'doc-1', token: 'abcdef' }))
        .rejects.toThrow('Invalid token')
    })

    it('rejects \'alg: none\' attack (unsigned tokens)', async () => {
      // Classic JWT attack: attacker takes a valid header/payload and
      // signs with alg:none + empty signature, hoping the verifier skips
      // signature validation. jsonwebtoken.verify with a string secret
      // defaults to HMAC algorithms (HS256/384/512) and rejects alg:none.
      // Pin the behaviour.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({
        docId: 'doc-1',
        userId: 1,
        readOnly: false,
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url')
      const unsignedToken = `${header}.${payload}.`
      await expect(auth({ documentName: 'doc-1', token: unsignedToken }))
        .rejects.toThrow('Invalid token')
    })

    it('rejects RS256-signed token when configured with HMAC secret (algorithm confusion guard)', async () => {
      // If the attacker controls the `alg` field, they might try signing
      // with a different algorithm. With a string (HMAC) secret,
      // jsonwebtoken should only accept HMAC algorithms and reject
      // asymmetric ones.
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({
        docId: 'doc-1',
        userId: 1,
        readOnly: false,
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url')
      // Even with a "signature" (arbitrary bytes), HS-expecting verifier
      // rejects RS256-tagged tokens.
      const fakeToken = `${header}.${payload}.fakeSignatureBytes`
      await expect(auth({ documentName: 'doc-1', token: fakeToken }))
        .rejects.toThrow('Invalid token')
    })
  })

  describe('readOnly safe-default (critical — prevents escalation)', () => {
    it('returns readOnly=true when claim is missing', async () => {
      // Regression target: if a JWT omits the readOnly claim (e.g. a
      // hand-crafted token from a rotated-out secret compromise, or a
      // future mint change that forgets the field), the connection must
      // default to read-only — NEVER silently writable.
      const token = sign({ docId: 'doc-1', userId: 1 }) // readOnly omitted
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.readOnly).toBe(true)
    })

    it('returns readOnly=true when claim is explicitly true', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: true })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.readOnly).toBe(true)
    })

    it('returns readOnly=false ONLY when claim is explicitly false', async () => {
      // The one grant path for write access.
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.readOnly).toBe(false)
    })

    it('treats any non-false truthy-ish value as read-only', async () => {
      // Covers { readOnly: null }, { readOnly: 0 }, { readOnly: "" }, etc.
      // Only the literal boolean `false` unlocks writes.
      for (const val of [null, 0, '', 'false', 1] as unknown[]) {
        // Force through the signer by casting — the point is testing the
        // verifier's handling of junk values it might encounter from a
        // malformed but signed token.
        const token = sign({ docId: 'doc-1', userId: 1, readOnly: val as unknown as boolean })
        const ctx = await auth({ documentName: 'doc-1', token })
        expect(ctx.readOnly, `for readOnly=${JSON.stringify(val)}`).toBe(true)
      }
    })
  })

  describe('connectionConfig.readOnly enforcement (critical — the actual write gate)', () => {
    // Regression guard for the server-side read-only bug: the value returned
    // from onAuthenticate is merged into Hocuspocus request *context* only and
    // does NOT block writes. Hocuspocus blocks writes off `connection.readOnly`,
    // seeded from `connectionConfig.readOnly` (default `false`). The hook must
    // mutate that object, or every read-only token yields a writable connection.

    it('stamps connectionConfig.readOnly=true for a read-only token', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: true })
      const connectionConfig = { readOnly: false } // Hocuspocus default
      await auth({ documentName: 'doc-1', token, connectionConfig })
      expect(connectionConfig.readOnly).toBe(true)
    })

    it('stamps connectionConfig.readOnly=true when the claim is missing (safe default)', async () => {
      const token = sign({ docId: 'doc-1', userId: 1 }) // readOnly omitted
      const connectionConfig = { readOnly: false }
      await auth({ documentName: 'doc-1', token, connectionConfig })
      expect(connectionConfig.readOnly).toBe(true)
    })

    it('stamps connectionConfig.readOnly=false only for an explicitly writable token', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      const connectionConfig = { readOnly: false }
      await auth({ documentName: 'doc-1', token, connectionConfig })
      expect(connectionConfig.readOnly).toBe(false)
    })

    it('never leaves a read-only token on a writable connection default', async () => {
      // The exact bug: Hocuspocus hands us { readOnly: false }; a viewer JWT
      // must flip it to true, not pass through.
      for (const val of [null, 0, '', 'false', 1, true, undefined] as unknown[]) {
        const token = sign({ docId: 'doc-1', userId: 1, readOnly: val as unknown as boolean })
        const connectionConfig = { readOnly: false }
        await auth({ documentName: 'doc-1', token, connectionConfig })
        expect(connectionConfig.readOnly, `for readOnly=${JSON.stringify(val)}`).toBe(true)
      }
    })

    it('does not throw when connectionConfig is absent (test-shape call)', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.readOnly).toBe(false)
    })
  })

  describe('userName default', () => {
    it('returns null when userName claim is missing', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.userName).toBeNull()
    })

    it('returns null when userName claim is explicit null', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, userName: null, readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.userName).toBeNull()
    })

    it('passes through a string userName', async () => {
      const token = sign({ docId: 'doc-1', userId: 1, userName: 'Alice', readOnly: false })
      const ctx = await auth({ documentName: 'doc-1', token })
      expect(ctx.userName).toBe('Alice')
    })
  })

  describe('secret rotation', () => {
    it('accepts token signed with the previous secret during rotation', async () => {
      const token = jwt.sign(
        { docId: 'doc-1', userId: 1, readOnly: false },
        PREVIOUS_SECRET,
        { expiresIn: '2h' }
      )
      const ctx = await authWithRotation({ documentName: 'doc-1', token })
      expect(ctx.userId).toBe(1)
    })

    it('rejects previous-secret token when rotation is not configured', async () => {
      const token = jwt.sign(
        { docId: 'doc-1', userId: 1, readOnly: false },
        PREVIOUS_SECRET,
        { expiresIn: '2h' }
      )
      await expect(auth({ documentName: 'doc-1', token }))
        .rejects.toThrow('Invalid token')
    })

    it('rejects token signed with a third unrelated secret even with rotation on', async () => {
      const token = jwt.sign(
        { docId: 'doc-1', userId: 1, readOnly: false },
        OTHER_SECRET,
        { expiresIn: '2h' }
      )
      await expect(authWithRotation({ documentName: 'doc-1', token }))
        .rejects.toThrow('Invalid token')
    })

    it('accepts current-secret token even when rotation is configured', async () => {
      // The rotation fallback must not break the common path.
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      const ctx = await authWithRotation({ documentName: 'doc-1', token })
      expect(ctx.userId).toBe(1)
    })

    it('rejects expired token even if it would verify under the previous secret', async () => {
      // Expiry must take precedence over rotation fallback.
      const token = jwt.sign(
        { docId: 'doc-1', userId: 1, readOnly: false },
        PREVIOUS_SECRET,
        { expiresIn: '-1s' }
      )
      await expect(authWithRotation({ documentName: 'doc-1', token }))
        .rejects.toThrow('Invalid token')
    })
  })

  describe('expiry and not-before (open connections must not outlive their access)', () => {
    it('rejects a token without exp: it would authorize a connection forever', async () => {
      const token = jwt.sign({ docId: 'doc-1', userId: 1, readOnly: false }, SECRET)
      await expect(auth({ documentName: 'doc-1', token })).rejects.toThrow('Invalid token')
    })

    it('rejects a token issued before the document\'s not-before cutoff', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      const guarded = createAuth({ secret: SECRET, notBeforeFor: async () => nowSec })
      const old = jwt.sign({ docId: 'doc-1', userId: 1, readOnly: false, iat: nowSec - 60 }, SECRET, { expiresIn: '2h' })
      await expect(guarded({ documentName: 'doc-1', token: old })).rejects.toThrow('Token revoked')
      // Minted in the cutoff second (after the access change was written): accepted.
      const fresh = jwt.sign({ docId: 'doc-1', userId: 1, readOnly: false, iat: nowSec }, SECRET, { expiresIn: '2h' })
      expect((await guarded({ documentName: 'doc-1', token: fresh })).userId).toBe(1)
    })

    it('asks for the cutoff of the document being opened, and ignores a missing one', async () => {
      const asked: string[] = []
      const guarded = createAuth({ secret: SECRET, notBeforeFor: async (docId) => {
        asked.push(docId)
        return null
      } })
      const token = sign({ docId: 'doc-1', userId: 1, readOnly: false })
      expect((await guarded({ documentName: 'doc-1', token })).userId).toBe(1)
      expect(asked).toEqual(['doc-1'])
    })

    it('createTokenVerifier applies the same rules as the handshake (used for renewals)', async () => {
      const verify = createTokenVerifier({ secret: SECRET })
      await expect(verify(sign({ docId: 'doc-2', userId: 1 }), 'doc-1')).rejects.toThrow('Token scope mismatch')
      const ok = await verify(sign({ docId: 'doc-1', userId: 1, readOnly: true }), 'doc-1')
      expect(ok.readOnly).toBe(true)
    })
  })
})
