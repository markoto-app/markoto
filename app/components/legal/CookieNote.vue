<script setup lang="ts">
// The profile page's short storage notice. It names the cookieless visitor
// statistics only where the instance runs them
// (NUXT_PUBLIC_ANALYTICS_WEBSITE_ID, docs/operations-analytics.md); an
// instance without them keeps "no analytics".
const { t } = useI18n()
const visitorStatistics = computed(() => Boolean(useRuntimeConfig().public.analytics?.websiteId))
</script>

<template>
  <p data-testid="profile-cookie-note">
    {{ visitorStatistics ? t('settings.profile.legal.cookieNoteWithStats') : t('settings.profile.legal.cookieNote') }}
  </p>
</template>
