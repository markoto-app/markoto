import { queryCollectionSearchSections } from '@nuxt/content/server'

// Docs search index (every docs page split into per-heading sections) for the
// Cmd-K modal in layouts/docs.vue. Fetched on demand by the client, not shipped
// in every docs page payload.
//
// Auth: whitelisted (GET) in server/middleware/auth.ts; the docs are public and
// so is everything in their index. Content is fixed at build time, so a browser
// may reuse the answer for a few minutes.
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return await queryCollectionSearchSections(event, 'docs')
})
