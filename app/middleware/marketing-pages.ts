// Route guard for hosted-only marketing pages (use cases, comparisons,
// templates; `definePageMeta({ middleware: 'marketing-pages' })`). They
// advertise the hosted markoto.app service, so every other instance 404s,
// like /legal/* without legal surfaces. Flag: NUXT_MARKETING_SITE_ENABLED
// (shared/config/instance.ts); the sitemap route checks it too.
export default defineNuxtRouteMiddleware(() => {
  const { marketingSite } = useInstanceConfig()
  if (marketingSite.value) return
  return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
})
