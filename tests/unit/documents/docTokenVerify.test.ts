import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import type { H3Event } from 'h3'
import { extractToken, verifyDocJwt } from '../../../server/utils/documents/docTokenVerify'

// Unit tests for the two pure halves of docTokenVerify. The combined
// `hasValidDocJwt` orchestrator is exercised by the files + activity
// integration suites (which rely on the full Nuxt runtime).
//
// Why these matter: this is the ONLY path by which an anonymous user
// who's verified a doc password can prove access on a plain HTTP
// request. A bug in either half silently downgrades that capability to
// "always rejected" (false negative, breaks feature) or "accepts any
// token" (false positive, security hole).

// extractToken

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

    it('treats "Bearer" + whitespace-only as no token (falls through to query)', () => {
      expect(extractToken(fakeEvent({ headers: { authorization: 'Bearer   ' } }))).toBeNull()
      const e = fakeEvent({
        headers: { authorization: 'Bearer   ' },
        url: '/?token=query-token'
      })
      expect(extractToken(e)).toBe('query-token')
    })

    it('accepts tab / mixed whitespace between Bearer and the token', () => {
      expect(extractToken(fakeEvent({ headers: { authorization: 'Bearer\tabc' } }))).toBe('abc')
      expect(extractToken(fakeEvent({ headers: { authorization: 'bearer \t abc' } }))).toBe('abc')
    })

    it('stays fast on adversarial whitespace-heavy headers (no backtracking)', () => {
      // The old /^Bearer\s+(.+)$/ regex backtracked super-linearly on
      // long whitespace runs; the prefix-test + slice must not.
      const evil = 'Bearer' + ' '.repeat(100_000) + '\n'
      const started = performance.now()
      extractToken(fakeEvent({ headers: { authorization: evil } }))
      expect(performance.now() - started).toBeLessThan(200)
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

// verifyDocJwt

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

  describe('scope claim (scope-narrowed tokens only where the endpoint opts in)', () => {
    it('refuses a file-access token unless the caller accepts that scope', () => {
      const token = sign({ docId: 'doc-1', scope: 'file-access' })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
      expect(verifyDocJwt(token, 'doc-1', SECRET, null, ['file-access'])).toBe(true)
    })

    it('refuses other scopes even where file-access is accepted', () => {
      for (const scope of ['dictate', 'render', '', 1]) {
        const token = sign({ docId: 'doc-1', scope })
        expect(verifyDocJwt(token, 'doc-1', SECRET, null, ['file-access']), String(scope)).toBe(false)
      }
    })

    it('still accepts scope-less session tokens where file-access is accepted', () => {
      const token = sign({ docId: 'doc-1', userId: 7 })
      expect(verifyDocJwt(token, 'doc-1', SECRET, null, ['file-access'])).toBe(true)
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

  // Adversarial: algorithm pinning
  //
  // Finding during review: without `algorithms` pinned in `jwt.verify`,
  // the library auto-detects from the token header. This means a token
  // signed with HS384 or HS512 (or any HMAC variant) would be accepted
  // even though our signer always uses HS256. Not an immediate bug
  // (our 64-char shared secret is equally strong under any HS*), but
  // defense-in-depth: pin what we expect, reject anything else.
  //
  // The `verifyJwtWithRotation` primitive now passes `algorithms:
  // ['HS256']` explicitly. These tests pin that enforcement.

  describe('algorithm pinning (HS256-only)', () => {
    it('accepts HS256-signed tokens (baseline — the signer default)', () => {
      const token = jwt.sign({ docId: 'doc-1' }, SECRET, { algorithm: 'HS256' })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(true)
    })

    it('REJECTS HS384-signed tokens (defense-in-depth against alg downgrade)', () => {
      // Before the fix: this token was silently accepted because
      // jwt.verify auto-detected the alg from the header.
      const token = jwt.sign({ docId: 'doc-1' }, SECRET, { algorithm: 'HS384' })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
    })

    it('REJECTS HS512-signed tokens (same hardening)', () => {
      const token = jwt.sign({ docId: 'doc-1' }, SECRET, { algorithm: 'HS512' })
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
    })

    it('still enforces HS256-only during rotation (previous secret doesn\'t relax alg)', () => {
      // A token signed with the previous secret AND a non-HS256 alg
      // must still be rejected. The pinning applies to both verify
      // attempts in verifyJwtWithRotation, not just the first.
      const token = jwt.sign({ docId: 'doc-1' }, PREVIOUS, { algorithm: 'HS512' })
      expect(verifyDocJwt(token, 'doc-1', SECRET, PREVIOUS)).toBe(false)
    })
  })

  // Adversarial: temporal claims

  describe('nbf (not-before) claim', () => {
    it('rejects a token whose nbf is in the future (not yet valid)', () => {
      // An attacker intercepting a token meant for later use shouldn't
      // get early access. `jwt.verify` throws NotBeforeError, our catch
      // returns false.
      const nbf = Math.floor(Date.now() / 1000) + 3600 // 1h from now
      const token = jwt.sign({ docId: 'doc-1', nbf }, SECRET)
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(false)
    })

    it('accepts a token whose nbf is in the past (already valid)', () => {
      const nbf = Math.floor(Date.now() / 1000) - 3600 // 1h ago
      const token = jwt.sign({ docId: 'doc-1', nbf }, SECRET)
      expect(verifyDocJwt(token, 'doc-1', SECRET)).toBe(true)
    })
  })
})

// Adversarial: extractToken edge cases

describe('extractToken — adversarial edge cases', () => {
  it('returns null when the query token is an array (?token=a&token=b)', () => {
    // h3's getQuery returns an array when a key appears twice. The SUT
    // checks `typeof q === 'string'` which correctly rejects arrays.
    // If someone refactored that to `q ?? null` or similar, an attacker
    // passing `?token=valid&token=evil` could cause downstream code to
    // pick the wrong element depending on join-order. Belt + braces.
    const e = fakeEvent({ url: '/?token=first&token=second' })
    expect(extractToken(e)).toBeNull()
  })

  it('returns null when the query token is an array with one valid entry', () => {
    // Same rejection. Even a single "good" entry inside an array form
    // should be refused — if a client can put one, it can put multiple,
    // and the precedence is ambiguous.
    const e = fakeEvent({ url: '/?token[]=valid' })
    // h3 parses `token[]` as an array key; some parsers emit it as
    // either { 'token[]': 'valid' } OR { token: ['valid'] }. The SUT
    // treats both as "not a string" → null.
    expect(extractToken(e)).toBeNull()
  })

  it('Authorization header with trailing garbage after the token gets captured verbatim', () => {
    // Finding (not a bug, pinning behaviour): the regex `^Bearer\s+(.+)$`
    // is greedy — `Bearer abc def` captures "abc def". That whole
    // string goes into verifyDocJwt and fails signature check. Safe
    // (no verification bypass) but a client that accidentally appends
    // a comma-separated second auth scheme sees a rejected request.
    // Documented so a future "tighten the regex" change knows what
    // the current behaviour is.
    const e = fakeEvent({ headers: { authorization: 'Bearer good.token.here, Basic extra' } })
    expect(extractToken(e)).toBe('good.token.here, Basic extra')
  })
})
