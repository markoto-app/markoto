<script setup lang="ts">
// Placeholder for the editor area while a password-protected document is
// locked; the password modal sits on top of it.
const { t } = useI18n()
</script>

<template>
  <div class="flex-1 flex items-center justify-center">
    <div class="text-center text-muted">
      <UIcon
        name="i-lucide-lock"
        class="size-12 mb-4"
      />
      <p class="text-sm">
        {{ t('share.passwordRequiredDesc') }}
      </p>
    </div>
  </div>
</template>
