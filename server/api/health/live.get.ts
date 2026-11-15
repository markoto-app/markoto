import { getCachedLiveness } from '../../utils/platform/healthProbes'

// Routing liveness: what Traefik's load-balancer health check and the app
// container's healthcheck ask. 200 while this process answers and reaches
// Postgres and Valkey (a node with a broken Valkey connection would fail
// rate limits open, so it leaves routing); sync, the renderer, markitdown and
// LiteLLM are deliberately not part of it (`getCachedLiveness`). The full
// picture stays at `/api/health` (deploys, monitors) and `/api/health/deep`.
//
// Public (server/utils/auth/publicRoutes.ts).

export default defineApiHandler({
  access: allow.public('Routing liveness for Traefik and the container healthcheck; Postgres and Valkey status only, no hostnames or timings'),
  handler: async ({ event }) => {
    const live = await getCachedLiveness()
    setResponseStatus(event, live.status)
    return live.body
  }
})
