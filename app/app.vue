<script setup lang="ts">
import { fontStylesheetUrls } from '~~/shared/utils/themeFonts'

const { t } = useI18n()

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    // Brand fonts, calibrated against the homepage mockup. Inter is
    // the body/UI workhorse. JetBrains Mono is the eyebrow/meta/CTA
    // register. Fraunces (variable opsz + wght, upright + italic)
    // handles the wordmark, display headlines, and the AI's italic
    // voice. Served from our own origin (shared/utils/themeFonts.ts) —
    // no request leaves for Google Fonts.
    ...fontStylesheetUrls(['Inter', 'JetBrains Mono', 'Fraunces']).map(href => ({ rel: 'stylesheet', href }))
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

useSeoMeta({
  title: 'markoto — Collaborative Markdown',
  description: t('landing.subtitle'),
  ogTitle: 'markoto — Collaborative Markdown',
  ogDescription: t('landing.subtitle')
})
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
