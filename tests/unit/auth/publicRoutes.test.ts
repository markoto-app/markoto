import { describe, it, expect } from 'vitest'
import { isPublicRoute, PUBLIC_ROUTES, TEST_ONLY_PUBLIC_ROUTES } from '../../../server/utils/auth/publicRoutes'

// The allowlist moved out of server/middleware/auth.ts unchanged. This copy
// of the list as it stood in the middleware (plus its test-mode entry and
// HEAD-as-GET rule) must decide every probe identically. A deliberate change
// to the public surface edits both lists, which keeps it visible in review.

const PREVIOUS = [
  { path: /^\/api\/health$/, methods: ['GET'] },
  { path: /^\/api\/status$/, methods: ['GET'] },
  { path: /^\/api\/version$/, methods: ['GET'] },
  { path: /^\/api\/_auth\/session$/, methods: ['GET', 'DELETE'] },
  { path: /^\/api\/_nuxt_icon\//, methods: ['GET'] },
  { path: /^\/api\/billing\/tiers$/, methods: ['GET'] },
  { path: /^\/api\/billing\/prices$/, methods: ['GET'] },
  { path: /^\/api\/docs$/, methods: ['POST'] },
  { path: /^\/api\/docs\/[^/]+$/, methods: ['DELETE'] },
  { path: /^\/api\/docs\/[^/]+\/meta$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/pdf$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/file-token$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/token$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/password$/, methods: ['POST'] },
  { path: /^\/api\/docs\/[^/]+\/activity$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/activity\/[^/]+\/diff$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/activity\/[^/]+\/comment-context$/, methods: ['GET'] },
  { path: /^\/api\/files\/[^/]+\/[^/]+$/, methods: ['GET'] },
  { path: /^\/api\/docs\/[^/]+\/brand\/[^/]+$/, methods: ['GET'] },
  { path: /^\/api\/published\/[^/]+\/(?:files|brand)\/[^/]+$/, methods: ['GET'] },
  { path: /^\/api\/import$/, methods: ['POST'] },
  { path: /^\/api\/internal\/traefik\/custom-domains$/, methods: ['GET'] },
  { path: /^\/api\/_internal\/render-bootstrap$/, methods: ['GET'] },
  { path: /^\/api\/_internal\/flows-index$/, methods: ['GET'] },
  { path: /^\/api\/_internal\/docs-search$/, methods: ['GET'] },
  { path: /^\/api\/_internal\/legal\/[^/]+$/, methods: ['GET'] },
  { path: /^\/api\/_internal\/sub-processors$/, methods: ['GET'] },
  { path: /^\/api\/consent$/, methods: ['GET', 'POST'] },
  { path: /^\/api\/anon-gate\/challenge$/, methods: ['GET'] },
  { path: /^\/api\/abuse-reports$/, methods: ['POST'] },
  { path: /^\/api\/waitlist$/, methods: ['POST'] },
  { path: /^\/api\/auth\/sso\/discover$/, methods: ['POST'] },
  { path: /^\/api\/waitlist\/(?:confirm|unsubscribe)$/, methods: ['POST'] },
  { path: /^\/api\/webhooks\/stripe$/, methods: ['POST'] },
  { path: /^\/api\/ai\/dictate$/, methods: ['GET'] }
]
const PREVIOUS_TEST_ONLY = [{ path: /^\/api\/_test\//, methods: ['POST'] }]

function previousDecision(path: string, method: string, testMode: boolean): boolean {
  const m = method === 'HEAD' ? 'GET' : method
  return [...PREVIOUS, ...(testMode ? PREVIOUS_TEST_ONLY : [])].some(r => r.path.test(path) && r.methods.includes(m))
}

// Probe paths: every entry's own shape, plus near misses (extra segments,
// trailing slash, other prefixes) and routes that must stay private.
const PATHS = [
  '/api/health', '/api/health/', '/api/health/deep', '/api/status', '/api/version', '/api/_auth/session', '/api/_auth/session/x',
  '/api/_nuxt_icon/lucide.json', '/api/_test/login', '/api/_test/', '/api/billing/tiers', '/api/billing/prices', '/api/billing/checkout',
  '/api/docs', '/api/docs/', '/api/docs/abc', '/api/docs/abc/', '/api/docs/abc/meta', '/api/docs/abc/pdf', '/api/docs/abc/file-token',
  '/api/docs/abc/token', '/api/docs/abc/password', '/api/docs/abc/activity', '/api/docs/abc/activity/12/diff',
  '/api/docs/abc/activity/xx/comment-context', '/api/docs/abc/activity/12/restore', '/api/docs/abc/share-settings',
  '/api/docs/abc/duplicate', '/api/docs/abc/brand/f.woff2', '/api/docs/abc/brand/a/b', '/api/files/abc/f.png', '/api/files/abc',
  '/api/files/abc/f.png/x', '/api/published/s/files/f.png', '/api/published/s/brand/f.woff2', '/api/published/s/other/f',
  '/api/import', '/api/internal/traefik/custom-domains', '/api/internal/activity', '/api/_internal/render-bootstrap',
  '/api/_internal/flows-index', '/api/_internal/docs-search', '/api/_internal/legal/privacy', '/api/_internal/sub-processors',
  '/api/consent', '/api/anon-gate/challenge', '/api/abuse-reports', '/api/waitlist', '/api/waitlist/confirm',
  '/api/waitlist/unsubscribe', '/api/waitlist/other', '/api/auth/sso/discover', '/api/webhooks/stripe', '/api/webhooks/other',
  '/api/ai/dictate', '/api/ai/dictate/token', '/api/mcp/tokens', '/api/admin/users', '/api/user/delete', '/api/workspaces',
  '/apix/health', '/health'
]
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

describe('public routes allowlist', () => {
  it('decides exactly as the list it was moved from', () => {
    const diffs: string[] = []
    for (const testMode of [false, true]) {
      for (const path of PATHS) {
        for (const method of METHODS) {
          const before = previousDecision(path, method, testMode)
          const after = isPublicRoute(path, method, { testMode })
          if (before !== after) diffs.push(`${method} ${path} testMode=${testMode}: ${before} → ${after}`)
        }
      }
    }
    expect(diffs).toEqual([])
  })

  it('holds the same entries', () => {
    const show = (rs: ReadonlyArray<{ path: RegExp, methods: readonly string[] }>) => rs.map(r => `${r.path.source} ${[...r.methods].join(',')}`).sort()
    expect(show(PUBLIC_ROUTES)).toEqual(show(PREVIOUS))
    expect(show(TEST_ONLY_PUBLIC_ROUTES)).toEqual(show(PREVIOUS_TEST_ONLY))
  })

  it('test-only routes are public only in test mode; HEAD counts as GET', () => {
    expect(isPublicRoute('/api/_test/login', 'POST', { testMode: false })).toBe(false)
    expect(isPublicRoute('/api/_test/login', 'POST', { testMode: true })).toBe(true)
    expect(isPublicRoute('/api/health', 'HEAD', { testMode: false })).toBe(true)
  })
})
