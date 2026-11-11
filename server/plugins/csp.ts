import { randomBytes } from 'node:crypto'
import { addNonceToScripts, buildAppCsp, buildRenderCsp, crossOriginResourcePolicyFor } from '../utils/rendering/csp'

// Sets the Content-Security-Policy (with a fresh nonce per response) and
// Cross-Origin-Resource-Policy on every response, and stamps that nonce on
// the inline scripts Nuxt renders into the page. Policies: server/utils/rendering/csp.ts.
//
// The app owns these headers (not Traefik) so that every deployment shape —
// hosted, self-host, local, the test stacks — serves the same policy, and so
// the nonce can match the HTML it belongs to.
//
// Dev server (`nuxt dev`): no CSP — Vite's HMR client and devtools inject
// scripts this policy would refuse. The production build (also used by the
// integration + flow test stacks) always sends it.

declare module 'h3' {
  interface H3EventContext {
    /** CSP nonce of this response (empty when no CSP is sent). */
    cspNonce?: string
  }
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const path = event.path
    // CORP per path — see `crossOriginResourcePolicyFor` (the preview
    // iframes' opaque origin makes their image requests cross-site).
    setResponseHeader(event, 'Cross-Origin-Resource-Policy', crossOriginResourcePolicyFor(path))

    if (import.meta.dev) return

    const nonce = randomBytes(18).toString('base64')
    event.context.cspNonce = nonce
    const config = useRuntimeConfig(event)
    const s3Origin = config.s3.publicEndpoint || config.s3.endpoint
    const csp = path.startsWith('/_internal/render/')
      ? buildRenderCsp({ nonce, s3Origin, extraOrigins: process.env.RENDERER_ALLOWED_ORIGINS })
      : buildAppCsp({
          nonce,
          s3Origin,
          syncUrl: config.public.syncUrl,
          sentryDsn: config.public.sentry?.dsn,
          siteUrl: typeof config.siteUrl === 'string' ? config.siteUrl : undefined
        })
    setResponseHeader(event, 'Content-Security-Policy', csp)
  })

  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = event.context.cspNonce
    if (!nonce) return
    // Only Nuxt's own chunks (head + body edges). The app body itself is
    // NOT touched: it is rendered page content, and stamping the nonce on
    // a `<script` that ended up in it would defeat the policy.
    html.head = html.head.map(chunk => addNonceToScripts(chunk, nonce))
    html.bodyPrepend = html.bodyPrepend.map(chunk => addNonceToScripts(chunk, nonce))
    html.bodyAppend = html.bodyAppend.map(chunk => addNonceToScripts(chunk, nonce))
  })
})
