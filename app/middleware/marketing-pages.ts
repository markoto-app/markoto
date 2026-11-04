// Route guard for hosted-only marketing pages (use cases, comparisons,
// templates — `definePageMeta({ middleware: 'marketing-pages' })`). They
// advertise the hosted markoto.app service, so on every other instance
// (self-hosted, the default) they don't exist: 404, like the /legal/*
// pages without legal surfaces. Flag: NUXT_MARKETING_SITE_ENABLED, see
// shared/config/instance.ts. The sitemap route checks the same flag.
export default defineNuxtRouteMiddleware(() => {
  const { marketingSite } = useInstanceConfig()
  if (marketingSite.value) return
  return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
})
