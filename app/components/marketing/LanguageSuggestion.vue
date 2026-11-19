<script setup lang="ts">
import { preferredMarketingLocale, splitMarketingLocale, type MarketingVariant } from '~~/shared/seo/marketing'

// "This page is also available in German": a small card for a visitor
// whose language (the locale cookie, else the browser's languages) differs
// from the page's URL and has a version of this page. Never a redirect:
// every URL answers in its own language for everyone, crawlers included,
// so search engines index each version as it is. The card is decided in
// the browser after mount (nothing in the server render, no layout shift),
// is skipped for automated browsers, and is worded in the suggested
// language. Dismissing hides it for the rest of the visit (in memory,
// nothing stored).

const route = useRoute()
const i18n = useNuxtApp().$i18n
const variants = useCurrentMarketingVariants()
const choose = useChooseMarketingLanguage()
const dismissed = useState('marketing-language-dismissed', () => false)
const cookie = useCookie<string | null>('ypad_locale', { readonly: true })

const suggestion = ref<MarketingVariant | null>(null)
const texts = ref({ suggestion: '', switch: '', dismiss: '' })

/** Crawlers, previews and test browsers never get the card. */
function isAutomated(): boolean {
  return navigator.webdriver || /bot|crawl|spider|slurp|preview|lighthouse|headless/i.test(navigator.userAgent)
}

async function decide(): Promise<void> {
  suggestion.value = null
  if (dismissed.value || isAutomated()) return
  const current = splitMarketingLocale(route.path).locale
  const preferred = preferredMarketingLocale(cookie.value, navigator.languages)
  if (!preferred || preferred === current) return
  const variant = variants.value.find(v => v.locale === preferred)
  if (!variant) return
  const locale = i18n.locales.value.find(l => l.code === preferred)?.code
  if (!locale) return
  await i18n.loadLocaleMessages(locale)
  const tIn = (key: string) => i18n.t(key, {}, { locale })
  texts.value = { suggestion: tIn('marketing.language.suggestion'), switch: tIn('marketing.language.switch'), dismiss: tIn('marketing.language.dismiss') }
  suggestion.value = variant
}

onMounted(() => {
  watch([() => route.path, variants], () => void decide(), { immediate: true })
})

function accept(): void {
  if (suggestion.value) void choose(suggestion.value)
}

function dismiss(): void {
  dismissed.value = true
  suggestion.value = null
}
</script>

<template>
  <div
    v-if="suggestion"
    class="fixed bottom-4 left-4 right-4 sm:right-auto sm:max-w-sm z-40 rounded-md border border-default bg-default px-4 py-3 shadow-lg flex items-center gap-3"
    role="region"
    :lang="suggestion.locale"
    :aria-label="texts.suggestion"
    data-testid="marketing-language-suggestion"
  >
    <p class="text-sm flex-1">
      {{ texts.suggestion }}
    </p>
    <UButton
      size="xs"
      color="neutral"
      :to="suggestion.path"
      :hreflang="suggestion.locale"
      @click.prevent="accept"
    >
      {{ texts.switch }}
    </UButton>
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-lucide-x"
      :aria-label="texts.dismiss"
      @click="dismiss"
    />
  </div>
</template>
