import { buildRenderCsp } from '../utils/renderCsp'

// Second layer behind the renderer sidecar's request allowlist: a CSP on the
// internal print page itself. See server/utils/renderCsp.ts.
export default defineEventHandler((event) => {
  if (!getRequestURL(event).pathname.startsWith('/_internal/render/')) return
  const { s3 } = useRuntimeConfig()
  setResponseHeader(event, 'Content-Security-Policy', buildRenderCsp({
    s3Origin: s3.publicEndpoint || s3.endpoint,
    extraOrigins: process.env.RENDERER_ALLOWED_ORIGINS
  }))
})
