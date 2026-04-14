// Exposes the current SPA build id so the client can detect when a deployed
// build differs from what the user has loaded — and prompt them to reload.
//
// `useRuntimeConfig().app.buildId` is set by Nuxt at build time (a hash in
// production, the literal string "dev" in development).
export default defineEventHandler(() => {
  const config = useRuntimeConfig()
  return { buildId: config.app.buildId }
})
