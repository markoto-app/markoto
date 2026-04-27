<script setup lang="ts">
const { t } = useI18n()

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

useSeoMeta({
  title: 'YPad — Collaborative Markdown',
  description: t('landing.subtitle'),
  ogTitle: 'YPad — Collaborative Markdown',
  ogDescription: t('landing.subtitle')
})
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }">
    <!-- Browser-level offline banner — shown above all routes so the
         user sees it everywhere (dashboard, editor, workspace, docs).
         Auto-hides when the network comes back. -->
    <CommonOfflineBanner />
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
