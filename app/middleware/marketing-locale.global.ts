import { isLocalisedUiRoute, uiPageOfRoute } from '~~/shared/seo/marketing'

// The per-language copies of the marketing UI pages (`/de`, `/de/pricing`,
// `/fr/demo`, ...; shared/seo/marketing.ts, nuxt.config.ts `pages:extend`):
//  - exist only on the marketing site; every other instance 404s, like
//    the content pages (middleware/marketing-pages.ts);
//  - `/de` is the product tour in German. A signed-in visitor's home is
//    the dashboard, which keeps their own language at `/`.
export default defineNuxtRouteMiddleware((to) => {
  const name = typeof to.name === 'string' ? to.name : null
  if (!isLocalisedUiRoute(name)) return
  const { marketingSite } = useInstanceConfig()
  if (!marketingSite.value) {
    return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
  }
  if (uiPageOfRoute(name) === '/' && useUserSession().loggedIn.value) return navigateTo('/', { replace: true })
})
