<script setup lang="ts">
const { t } = useI18n()

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    // Brand fonts, calibrated against the homepage mockup. Inter is
    // the body/UI workhorse. JetBrains Mono is the eyebrow/meta/CTA
    // register. Fraunces (variable opsz, weights 300–500 upright +
    // 300–500 italic) handles the wordmark, display headlines, and
    // the AI's italic voice. Preconnect avoids a serial DNS hop.
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
    {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400&family=Fraunces:ital,opsz,wght@0,9..144,300..500;1,9..144,300..500&display=swap'
    }
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
