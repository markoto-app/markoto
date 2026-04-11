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
    <NuxtPage />
  </UApp>
</template>
