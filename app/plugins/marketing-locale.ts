import { marketingUrlLocale } from '~~/shared/seo/marketing'

// UI language of the public marketing pages (shared/seo/marketing.ts):
// on the marketing site, `/`, `/pricing`, `/demo` and the content pages
// are English, `/de/…`, `/fr/…` (and the other prefixes) are in their
// language, whatever the cookie or Accept-Language say. So a crawler and
// a visitor see the same language for the same address, and the page's
// canonical, hreflang and `<html lang>` agree with it.
//
// Every other route (the app, the docs, the legal pages, `/` for a
// signed-in visitor, every route off the marketing site) keeps the
// visitor's language: cookie, else Accept-Language (`no_prefix`). The
// override is temporary: the language in force before the first
// marketing page is restored on the first navigation to such a route.
// Those responses depend on Accept-Language, so the server render says so
// (`Vary: Accept-Language`); the marketing pages' responses don't.
//
// Set on the vue-i18n composer directly: `setLocale()` would also write the
// `ypad_locale` cookie, and reading a German page isn't choosing German for
// the app (the language switcher on the marketing pages does choose,
// useMarketingLanguages).
export default defineNuxtPlugin({
  name: 'markoto:marketing-locale',
  dependsOn: ['i18n:plugin:route-locale-detect'],
  async setup(nuxtApp) {
    const i18n = nuxtApp.$i18n
    const router = nuxtApp.$router
    const { marketingSite } = useInstanceConfig()
    const { loggedIn } = useUserSession()
    type Locale = typeof i18n.locale.value
    // The language in force before the first marketing page (SSR → client via payload).
    const before = useMarketingLocaleBefore()

    async function switchTo(locale: Locale): Promise<void> {
      if (i18n.locale.value === locale) return
      await i18n.loadLocaleMessages(locale)
      i18n.locale.value = locale
    }

    function urlLocale(path: string): Locale | null {
      const resolved = router.resolve(path)
      return marketingUrlLocale({
        routeName: typeof resolved.name === 'string' ? resolved.name : null,
        path: resolved.path,
        marketingSite: marketingSite.value,
        signedIn: loggedIn.value
      })
    }

    async function apply(path: string): Promise<Locale | null> {
      const fromUrl = urlLocale(path)
      if (fromUrl) {
        before.value ??= i18n.locale.value
        await switchTo(fromUrl)
        return fromUrl
      }
      const restore = before.value
      if (restore !== null) {
        before.value = null
        await switchTo(restore)
      }
      return null
    }

    // The router hasn't resolved the first route yet; the request URL
    // (window.location on the client) is the page being rendered.
    const first = await apply(useRequestURL().pathname)
    if (import.meta.server && first === null) {
      const event = useRequestEvent()
      if (event) appendResponseHeader(event, 'Vary', 'Accept-Language')
    }
    router.beforeEach(async (to) => {
      await apply(to.fullPath)
    })
  }
})
