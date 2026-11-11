import { isTestModeEnabled } from '../../shared/utils/security/testMode'
import { classifyInternalRoute, rejectIfFromEdge, requireInternalSecret } from '../utils/platform/internalRoutes'
import { isPublicRoute } from '../utils/auth/publicRoutes'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // HEAD is semantically a GET without a body — external monitors and
  // some proxies probe /api/health with HEAD. Treat it as GET for the
  // whitelist check so a HEAD to a public GET route isn't 401'd.
  const method = event.method === 'HEAD' ? 'GET' : event.method

  // Service-to-service routes (see server/utils/platform/internalRoutes.ts). Checked
  // here rather than in each handler so a new route under these prefixes
  // can't forget its gate: never served to the public edge, and
  // /api/internal/** needs the internal secret instead of a session. The
  // Traefik-provider route and the render routes carry their own tokens
  // and continue to the public-route list below.
  const internalKind = classifyInternalRoute(path, method)
  if (internalKind) {
    rejectIfFromEdge(event)
    if (internalKind === 'internal-api') {
      requireInternalSecret(event)
      // The classifier normalises the path (decoding, case, slashes) and the
      // router does not. Skip the session check only for a path the router
      // would itself send to an internal handler; anything else that merely
      // normalises to the prefix still needs a session below.
      if (path.startsWith('/api/internal/')) return
    }
  }

  // Only protect /api/ routes
  if (!path.startsWith('/api/')) return

  // DEFAULT-DENY: any /api route NOT on the public allowlist
  // (server/utils/auth/publicRoutes.ts) requires a valid session; there is
  // no fall-through-open branch, so a future admin route that forgets its
  // policy is still not world-readable.
  if (isPublicRoute(path, method, { testMode: isTestModeEnabled() })) return

  // DEFAULT-DENY: every other /api route requires a valid session.
  // This is the middleware backstop for admin routes, billing, user
  // data, workspaces, MCP token management, and anything added in the
  // future — handlers still run their own finer-grained authz
  // (requireAdminUser, canManageDoc, workspace roles) on top.
  //
  // Uses the validated helper so stale-user sessions are cleared centrally.
  // Result is cached on event.context — endpoints that call the helper again
  // don't re-query the DB.
  await requireValidatedUserSession(event)
})
