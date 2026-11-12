<script setup lang="ts">
// Nuxt renders this instead of `app.vue` for any unhandled page error
// (404 for an unknown route, 5xx for a failed render), so it has to bring its
// own shell: UApp for Nuxt UI, the brand fonts and the page chrome.
//
// The text is picked by status here, never taken from `error.message`: a
// server error message can carry internals (the framework-level error
// handler already strips them from API responses; this page must not
// re-introduce them from the page-render path).
import type { NuxtError } from '#app'
import { uiFontStylesheetUrls } from '~~/shared/utils/theme/themeFonts'
import { de, en, es, fr, ja, zh_cn } from '@nuxt/ui/locale'

const props = defineProps<{ error: NuxtError }>()

const { t, locale, localeProperties } = useI18n()

const isNotFound = computed(() => props.error.statusCode === 404)
const title = computed(() => isNotFound.value ? t('error.page.notFoundTitle') : t('error.page.genericTitle'))
const message = computed(() => isNotFound.value ? t('error.page.notFoundMessage') : t('error.page.genericMessage'))

const uiLocales = { en, de, fr, es, ja, zh: zh_cn }
const uiLocale = computed(() => uiLocales[locale.value] ?? en)

useHead({
  title: () => `${title.value} · markoto`,
  htmlAttrs: { lang: () => localeProperties.value.language ?? locale.value },
  // An error page is never worth indexing, whatever URL produced it.
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { name: 'robots', content: 'noindex' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ...uiFontStylesheetUrls(['Inter', 'JetBrains Mono', 'Fraunces']).map(href => ({ rel: 'stylesheet' as const, href }))
  ]
})

// `clearError` with a redirect leaves the error state and navigates in one
// step; going home by link alone would keep rendering this page.
function goHome(): void {
  void clearError({ redirect: '/' })
}
</script>

<template>
  <UApp :locale="uiLocale">
    <div
      class="min-h-[100dvh] bg-default text-default relative"
      data-testid="error-page"
    >
      <CommonHomeLink />
      <main class="max-w-md mx-auto px-4 py-24 sm:py-32 text-center">
        <!-- The status code is a number, not copy: set in the mono register used for meta text. -->
        <p
          class="font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted"
          data-testid="error-page-code"
        >
          {{ error.statusCode }}
        </p>
        <h1
          class="mt-3 font-serif text-3xl font-normal tracking-tight"
          data-testid="error-page-title"
        >
          {{ title }}
        </h1>
        <p
          class="mt-3 text-sm text-muted"
          data-testid="error-page-message"
        >
          {{ message }}
        </p>
        <UButton
          class="mt-8"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          data-testid="error-page-home"
          @click="goHome"
        >
          {{ t('error.page.backHome') }}
        </UButton>
      </main>
    </div>
  </UApp>
</template>
