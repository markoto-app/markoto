export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Only protect /api/ routes
  if (!path.startsWith('/api/')) return

  // Public routes that don't require authentication
  const publicRoutes = [
    { path: /^\/api\/health$/, methods: ['GET'] },
    // Test-only login shim. Endpoint itself 404s unless TEST_MODE=1; still
    // whitelisted here so the auth middleware doesn't refuse it before the
    // handler even runs during integration tests.
    { path: /^\/api\/_test\//, methods: ['POST'] },
    { path: /^\/api\/docs$/, methods: ['POST'] }, // Anonymous doc creation allowed
    { path: /^\/api\/docs\/[^/]+$/, methods: ['DELETE'] }, // Anon doc owner-less deletion is endpoint-gated
    { path: /^\/api\/docs\/[^/]+\/meta$/, methods: ['GET'] }, // Public doc metadata
    { path: /^\/api\/docs\/[^/]+\/token$/, methods: ['GET'] }, // Returns anonymous token if no session
    { path: /^\/api\/docs\/[^/]+\/password$/, methods: ['POST'] }, // Password verify is public; set/remove check ownership inside
    { path: /^\/api\/docs\/[^/]+\/activity$/, methods: ['GET'] }, // Endpoint-gated — public on open-edit/open-view, members-only on private/password-protected
    // Match ANY activityId segment (not just `\d+`) so malformed ids
    // hit the endpoint's own validation (400) rather than the auth
    // middleware's 401 — clearer errors for bad clients, identical
    // security envelope for valid ones.
    { path: /^\/api\/docs\/[^/]+\/activity\/[^/]+\/diff$/, methods: ['GET'] }, // Endpoint-gated — same auth tiers as /activity (decideActivityAccess)
    { path: /^\/api\/docs\/[^/]+\/activity\/[^/]+\/comment-context$/, methods: ['GET'] }, // Endpoint-gated — same auth tiers as /activity
    // /restore is NOT in the public whitelist — the endpoint itself
    // requires `requireDocEditAccess`, which needs a user session.
    // Falls through to the protected branch below.
    { path: /^\/api\/import$/, methods: ['POST'] }, // Import is public — user uploads their own file for conversion
    { path: /^\/api\/internal\//, methods: ['POST'] }, // Internal endpoints auth via shared secret header (not user session)
    // Stripe webhooks: auth'd via `Stripe-Signature` header + our
    // webhook secret. No user session — Stripe's servers don't have
    // one. Handler does full cryptographic signature verification.
    { path: /^\/api\/webhooks\/stripe$/, methods: ['POST'] },
    // Live-dictation WS relay: authenticated via short-lived JWT in
    // the upgrade URL (`?token=`), not the session cookie — crossws
    // gives the upgrade hook a raw Request, not an H3Event, so reading
    // the sealed cookie there isn't feasible. The JWT itself is minted
    // by POST /api/ai/dictate/token which still requires a session.
    { path: /^\/api\/ai\/dictate$/, methods: ['GET'] }
  ]

  const isPublic = publicRoutes.some(
    route => route.path.test(path) && route.methods.includes(event.method)
  )

  if (isPublic) return

  // All other API routes require authentication
  const protectedPrefixes = [
    '/api/docs/', // doc mutations (PUT, DELETE)
    '/api/workspaces',
    '/api/user',
    '/api/upload',
    '/api/import',
    '/api/ai',
    '/api/billing' // checkout + portal — user-triggered Stripe actions
  ]

  if (protectedPrefixes.some(p => path.startsWith(p))) {
    // Uses the validated helper so stale-user sessions are cleared centrally.
    // Result is cached on event.context — endpoints that call the helper again
    // don't re-query the DB.
    await requireValidatedUserSession(event)
  }
})
