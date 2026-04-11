<script setup lang="ts">
const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col gap-2">
    <UButton
      to="/auth/github"
      external
      icon="i-simple-icons-github"
      color="neutral"
      variant="subtle"
      block
    >
      {{ t('auth.loginGithub') }}
    </UButton>
    <UButton
      to="/auth/google"
      external
      icon="i-simple-icons-google"
      color="neutral"
      variant="subtle"
      block
    >
      {{ t('auth.loginGoogle') }}
    </UButton>
  </div>
</template>
