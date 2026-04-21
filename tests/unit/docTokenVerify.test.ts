import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import type { H3Event } from 'h3'
import { extractToken, verifyDocJwt } from '../../server/utils/docTokenVerify'

// Unit tests for the two pure halves of docTokenVerify. The combined
// `hasValidDocJwt` orchestrator is exercised by the files + activity
// integration suites (which rely on the full Nuxt runtime).
//
// Why these matter: this is the ONLY path by which an anonymous user
// who's verified a doc password can prove access on a plain HTTP
// request. A bug in either half silently downgrades that capability to
// "always rejected" (false negative, breaks feature) or "accepts any
// token" (false positive, security hole).

// ─── extractToken ───────────────────────────────────────────────────────

/**
 * Build a minimal H3Event shape that `getRequestHeader` + `getQuery`
 * from h3 will consume. h3's `getRequestHeader` reads
 * `event.node.req.headers`; `getQuery` reads `event.path` (the
 * request-line path, not the full URL). Tests only touch those two
 * sources.
 */
function fakeEvent({
  headers = {},
  url = '/'
}: { headers?: Record<string, string>, url?: string } = {}): H3Event {
  return {
    path: url,
    node: {
      req: { headers, url }
    }
  } as unknown as H3Event
}

describe('extractToken', () => {
  describe('Authorization: Bearer header', () => {
    it('extracts the token after "Bearer "', () => {
      const e = fakeEvent({ headers: { authorization: 'Bearer abc.def.ghi' } })
      expect(extractToken(e)).toBe('abc.def.ghi')
    })

    it('is case-insensitive on the Bearer prefix', () => {
      // Some HTTP clients emit `bearer`; the RFC-6750 prefix is
      // case-insensitive. Anything else would brittle-break real
      // clients for a cosmetic reason.
      expect(extractToken(fakeEvent({ headers: { authorization: 'bearer xyz' } }))).toBe('xyz')
      expect(extractToken(fakeEvent({ headers: { authorization: 'BEARER xyz' } }))).toBe('xyz')
      expect(extractToken(fakeEvent({ headers: { authorization: 'BeArEr xyz' } }))).toBe('xyz')
    })

    it('tolerates multiple spaces between Bearer and the token', () => {
      // \s+ in the regex. Real clients sometimes pad.
      expect(extractToken(fakeEvent({ headers: { authorization: 'Bearer   abc' } }))).toBe('abc')
    })

    it('trims trailing whitespace from the token', () => {
      expect(extractToken(fakeEvent({ headers: { authorization: 'Bearer abc   ' } }))).toBe('abc')
    })

    it('returns null for a Basic auth header (wrong scheme)', () => {
      expect(extractToken(fakeEvent({ headers: { authorization: 'Basic Zm9vOmJhcg==' } }))).toBeNull()
    })

    it('returns null when the header is just "Bearer" with no token', () => {
      // Regex requires \s+(.+), so bare "Bearer" + nothing doesn't match.
      expect(extractToken(fakeEvent({ headers: { authorization: 'Bearer' } }))).toBeNull()
    })

    it('returns null for an empty authorization header', () => {
      expect(extractToken(fakeEvent({ headers: { authorization: '' } }))).toBeNull()
    })
  })

  describe('?token= query param', () => {
    it('falls back to the query param when no header is present', () => {
      const e = fakeEvent({ url: '/?token=query-token' })
      expect(extractToken(e)).toBe('query-token')
    })

    it('URL-decodes the query value (handled by getQuery)', () => {
      // JWTs don't need encoding but test the standard parse path.
      const e = fakeEvent({ url: '/?token=hello%2Eworld' })
      expect(extractToken(e)).toBe('hello.world')
    })

    it('returns null when the query param is empty', () => {
      expect(extractToken(fakeEvent({ url: '/?token=' }))).toBeNull()
    })

    it('returns null when no token key is present', () => {
      expect(extractToken(fakeEvent({ url: '/?other=thing' }))).toBeNull()
    })
  })

  describe('precedence + edge cases', () => {
    it('header wins when both header and query are present', () => {
      // Programmatic clients (curl, scripts) set the header — that's
      // the more explicit channel and should always take precedence
      // over URL-embedded tokens.
      const e = fakeEvent({
        headers: { authorization: 'Bearer header-wins' },
        url: '/?token=query-loses'
      })
      expect(extractToken(e)).toBe('header-wins')
    })

    it('falls through to query when header is present but wrong-scheme', () => {
      const e = fakeEvent({
        headers: { authorization: 'Digest nonsense' },
        url: '/?token=query-works'
      })
      expect(extractToken(e)).toBe('query-works')
    })

    it('returns null when neither header nor query carry a token', () => {
      expect(extractToken(fakeEvent())).toBeNull()
    })
  })
})

// ─── verifyDocJwt ───────────────────────────────────────────────────────

const SECRET = 'verify-docjwt-test-' + 'a'.repeat(64)
const PREVIOUS = 'verify-docjwt-prev-' + 'b'.repeat(64)
const WRONG = 'some-other-secret-' + 'c'.repeat(64)

function sign(payload: object, opts: jwt.SignOptions = {}, key = SECRET): string {
  return jwt.sign(payload, key, { expiresIn: '2h', ...opts })
}

describe('verifyDocJwt', () => {
  describe('happy path', () => {
    it('returns true for a valid token with matching docId', () => {
      const token = sign({ docId: 'doc-1', userId: 'anonymous' })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(true)
    })

    it('works with extra JWT claims (userName, readOnly) the verifier doesn\'t read', () => {
      const token = sign({ docId: 'doc-1', userId: 42, userName: 'Alice', readOnly: false })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(true)
    })
  })

  describe('docId scope (critical — cross-doc replay guard)', () => {
    it('returns false when docId claim does not match', () => {
      const token = sign({ docId: 'doc-A' })
      expect(verifyDocJwt(token, 'doc-B', SECRET)).toBe(false)
    })

    it('returns false when docId claim is missing entirely', () => {
      const token = sign({ userId: 42 })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
    })

    it('returns false when docId claim is not a string', () => {
      const token = sign({ docId: 42 })
      expect(verifyDocJwt(token, '42', SECRET)).toBe(false)
    })

    it('enforces exact equality (no prefix/substring matching)', () => {
      const token = sign({ docId: 'doc-1' })
      expect(verifyDocJwt(token, 'doc-11', SECRET)).toBe(false)
      expect(verifyDocJwt(token, 'doc-', SECRET)).toBe(false)
      expect(verifyDocJwt(token, '', SECRET)).toBe(false)
    })
  })

  describe('signature / expiry', () => {
    it('returns false for a token signed with a different secret', () => {
      const token = sign({ docId: 'doc-1' }, {}, WRONG)
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
    })

    it('returns false for an expired token', () => {
      const token = sign({ docId: 'doc-1' }, { expiresIn: '-1s' })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
    })

    it('returns false for a malformed JWT', () => {
      expect(verifyDocJwt('not.a.jwt', 'doc-1', SECRET)).toBe(false)
    })

    it('returns false for an empty token', () => {
      expect(verifyDocJwt('', 'doc-1', SECRET)).toBe(false)
    })

    it('returns false for random garbage', () => {
      expect(verifyDocJwt('abcdef', 'doc-1', SECRET)).toBe(false)
    })

    it('returns false for an "alg: none" unsigned token', () => {
      // jsonwebtoken.verify with a string secret rejects alg:none by
      // default. Pin the behaviour — an accepted alg:none here would
      // let an attacker mint arbitrary docId claims with no signature.
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({
        docId: 'doc-1',
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString('base64url')
      expect(verifyDocJwt(`${header}.${payload}.`, 'doc-1', SECRET)).toBe(false)
    })
  })

  describe('secret rotation', () => {
    it('accepts a token signed with the previous secret during rotation', () => {
      const token = sign({ docId: 'doc-1' }, {}, PREVIOUS)
      expect(verifyDocJwt(token, 'doc-1', SECRET, PREVIOUS)).toBe(true)
    })

    it('rejects a previous-secret token when rotation is not configured', () => {
      const token = sign({ docId: 'doc-1' }, {}, PREVIOUS)
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
      expect(verifyDocJwt(token, 'doc-1', SECRET, null)).toBe(false)
      expect(verifyDocJwt(token, 'doc-1', SECRET, '')).toBe(false)
    })

    it('rejects a token signed with an unrelated third secret even under rotation', () => {
      const token = sign({ docId: 'doc-1' }, {}, WRONG)
      expect(verifyDocJwt(token, 'doc-1', SECRET, PREVIOUS)).toBe(false)
    })

    it('still accepts current-secret tokens when rotation is configured', () => {
      // Rotation fallback must not break the common path.
      const token = sign({ docId: 'doc-1' })
      expect(verifyDocJwt(token, 'doc-1', SECRET, PREVIOUS)).toBe(true)
    })

    it('rejects an expired token even if it would verify under the previous secret', () => {
      // Expiry takes precedence over rotation — a token past its TTL
      // is dead regardless of which signing key was used.
      const token = sign({ docId: 'doc-1' }, { expiresIn: '-1s' }, PREVIOUS)
      expect(verifyDocJwt(token, 'doc-1', SECRET, PREVIOUS)).toBe(false)
    })
  })
})
