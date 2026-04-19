export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Only protect /api/ routes
  if (!path.startsWith('/api/')) return

  // Public routes that don't require authentication
  const publicRoutes = [
    { path: /^\/api\/health$/, methods: ['GET'] },
    { path: /^\/api\/docs$/, methods: ['POST'] },  // Anonymous doc creation allowed
    { path: /^\/api\/docs\/[^/]+\/meta$/, methods: ['GET'] },  // Public doc metadata
    { path: /^\/api\/docs\/[^/]+\/token$/, methods: ['GET'] },  // Returns anonymous token if no session
    { path: /^\/api\/docs\/[^/]+\/password$/, methods: ['POST'] },  // Password verify is public; set/remove check ownership inside
    { path: /^\/api\/docs\/[^/]+\/activity$/, methods: ['GET'] },  // Activity log is public for viewers
    { path: /^\/api\/import$/, methods: ['POST'] },  // Import is public — user uploads their own file for conversion
    { path: /^\/api\/internal\//, methods: ['POST'] }  // Internal endpoints auth via shared secret header (not user session)
  ]

  const isPublic = publicRoutes.some(
    route => route.path.test(path) && route.methods.includes(event.method)
  )

  if (isPublic) return

  // All other API routes require authentication
  const protectedPrefixes = [
    '/api/docs/',     // doc mutations (PUT, DELETE)
    '/api/workspaces',
    '/api/user',
    '/api/upload',
    '/api/import',
    '/api/ai'
  ]

  if (protectedPrefixes.some(p => path.startsWith(p))) {
    // Uses the validated helper so stale-user sessions are cleared centrally.
    // Result is cached on event.context — endpoints that call the helper again
    // don't re-query the DB.
    await requireValidatedUserSession(event)
  }
})
