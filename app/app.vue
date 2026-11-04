<script setup lang="ts">
import { fontStylesheetUrls } from '~~/shared/utils/themeFonts'
import { applyTitleTemplate } from '~~/shared/seo/meta'

const { t, locale, localeProperties } = useI18n()

useHead({
  // `%s · markoto`; pages set only their own title. Without one: the
  // default "markoto — Collaborative Markdown".
  titleTemplate: title => applyTitleTemplate(title),
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { name: 'theme-color', content: '#FAF8F4', media: '(prefers-color-scheme: light)' },
    { name: 'theme-color', content: '#14110D', media: '(prefers-color-scheme: dark)' }
  ],
  link: [
    // Brand seal on a bone tile (sumi in dark mode via the SVG's own
    // media query); the .ico is the fallback for browsers without SVG
    // favicons and for the bare /favicon.ico request.
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    // Brand fonts, calibrated against the homepage mockup. Inter is
    // the body/UI workhorse. JetBrains Mono is the eyebrow/meta/CTA
    // register. Fraunces (variable opsz + wght, upright + italic)
    // handles the wordmark, display headlines, and the AI's italic
    // voice. Served from our own origin (shared/utils/themeFonts.ts) —
    // no request leaves for Google Fonts.
    ...fontStylesheetUrls(['Inter', 'JetBrains Mono', 'Fraunces']).map(href => ({ rel: 'stylesheet', href }))
  ],
  htmlAttrs: {
    // The active UI language (cookie / Accept-Language, `no_prefix`).
    lang: () => localeProperties.value.language ?? locale.value
  }
})

// Fallback description; indexable pages set their own (useMarketingSeo,
// docs frontmatter). Open Graph tags come from useMarketingSeo only, so
// a page never shares another page's og:title.
useSeoMeta({
  description: () => t('landing.subtitle')
})

// <link rel="canonical"> for every page (shared/seo/paths.ts).
useCanonical()
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }">
    <!-- Offline / deletion-grace banners, onboarding gate, consent
         banner — kept off the server-render page. -->
    <CommonAppOverlays />
    <!-- NuxtLayout wraps NuxtPage with whatever layout the page opts
         into via definePageMeta({ layout: 'name' }). Pages without
         a layout meta render bare (no default layout file exists),
         so existing routes (/d/, /w/, /pricing, /) are unaffected.
         The /docs/* tree opts into the `docs` layout. -->
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
