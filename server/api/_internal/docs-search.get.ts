import { queryCollectionSearchSections } from '@nuxt/content/server'

// `_internal/docs-search`: the docs search index (every docs page split
// into per-heading sections) for the Cmd-K modal in layouts/docs.vue.
//
// It used to be fetched during the server render and shipped in every
// docs page's payload (~50 KB gzip of a ~67 KB page); the modal is
// client-only, so the layout now fetches it from here when search is
// about to open (pointer over / focus on the search button, Cmd-K).
//
// Auth: whitelisted (GET) in server/middleware/auth.ts — the docs are
// public and so is everything in their index. The content is fixed at
// build time, so a browser may reuse the answer for a few minutes.
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'public, max-age=300')
  return await queryCollectionSearchSections(event, 'docs')
})
