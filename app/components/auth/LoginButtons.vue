<script setup lang="ts">
const { t } = useI18n()
// Only providers with complete credentials are offered — an
// unconfigured one would end in a server error. A self-hosted instance
// without any login provider is anonymous-only.
const { loginOptions } = useLoginOptions()
</script>

<template>
  <div class="flex flex-col gap-2">
    <UButton
      v-for="option in loginOptions"
      :key="option.provider"
      :to="option.to"
      external
      :icon="option.icon"
      color="neutral"
      variant="subtle"
      block
      :data-testid="`login-${option.provider}`"
    >
      {{ option.label }}
    </UButton>
    <p
      v-if="loginOptions.length === 0"
      class="text-xs text-muted"
      data-testid="login-unavailable"
    >
      {{ t('auth.loginUnavailable') }}
    </p>
  </div>
</template>
