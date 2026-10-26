<script setup lang="ts">
import { loginPath, type LoginProvider } from '~~/shared/config/instance'

const { t } = useI18n()
// Only providers with a configured OAuth app (client id + secret) are
// offered — an unconfigured one would end in a server error. A
// self-hosted instance without any OAuth app is anonymous-only.
const { loginProviders } = useInstanceConfig()

const PROVIDER_UI: Record<LoginProvider, { icon: string, labelKey: string }> = {
  github: { icon: 'i-simple-icons-github', labelKey: 'auth.loginGithub' },
  google: { icon: 'i-simple-icons-google', labelKey: 'auth.loginGoogle' }
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <UButton
      v-for="provider in loginProviders"
      :key="provider"
      :to="loginPath(provider)"
      external
      :icon="PROVIDER_UI[provider].icon"
      color="neutral"
      variant="subtle"
      block
    >
      {{ t(PROVIDER_UI[provider].labelKey) }}
    </UButton>
    <p
      v-if="loginProviders.length === 0"
      class="text-xs text-muted"
      data-testid="login-unavailable"
    >
      {{ t('auth.loginUnavailable') }}
    </p>
  </div>
</template>
