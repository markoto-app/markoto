import { mediaAssetHeaders } from '../utils/rendering/mediaAssetHeaders'

// Cache-Control for the bundled media under /media/ (the demo video and
// its poster). Rules: server/utils/rendering/mediaAssetHeaders.ts. The
// `request` hook runs before Nitro's static-asset handler, which sets no
// Cache-Control of its own for public files.

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const headers = mediaAssetHeaders(event.path)
    if (headers) setResponseHeaders(event, headers)
  })
})
