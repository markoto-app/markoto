import { prefixedMarketingLocale } from '~~/shared/seo/marketing'

// UI language on localised marketing pages (`/de/…`, `/fr/…`, see
// shared/seo/marketing.ts) follows the URL, not the locale cookie, so a
// crawler and a visitor see the same language for the same address.
//
// The rest of the app stays `no_prefix` with the cookie language, so the
// override is temporary: the previous language is restored on the first
// navigation to an unprefixed route.
//
// Set on the vue-i18n composer directly: `setLocale()` would also write the
// `ypad_locale` cookie, and reading a German page isn't choosing German for the app.
export default defineNuxtPlugin({
  name: 'markoto:marketing-locale',
  dependsOn: ['i18n:plugin:route-locale-detect'],
  async setup(nuxtApp) {
    const i18n = nuxtApp.$i18n
    type Locale = typeof i18n.locale.value
    // The language in force before the first prefixed page (SSR → client via payload).
    const before = useState<Locale | null>('marketing-locale-before', () => null)

    async function switchTo(locale: Locale): Promise<void> {
      if (i18n.locale.value === locale) return
      await i18n.loadLocaleMessages(locale)
      i18n.locale.value = locale
    }

    async function apply(path: string): Promise<void> {
      const fromUrl = prefixedMarketingLocale(path)
      if (fromUrl) {
        before.value ??= i18n.locale.value
        await switchTo(fromUrl)
        return
      }
      const restore = before.value
      if (restore === null) return
      before.value = null
      await switchTo(restore)
    }

    // The router may not have resolved the first route yet; the request
    // URL (window.location on the client) is the page being rendered.
    await apply(useRequestURL().pathname)
    nuxtApp.$router.beforeEach(async (to) => {
      await apply(to.path)
    })
  }
})
