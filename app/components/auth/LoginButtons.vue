<script setup lang="ts">
const props = defineProps<{
  /** Page to come back to after signing in; the current page when unset. */
  returnTo?: string
}>()
const { t } = useAreaI18n()
const route = useRoute()
const backTo = (): string => props.returnTo ?? route.fullPath
// Only providers with complete credentials are offered, an
// unconfigured one would end in a server error. A self-hosted instance
// without any login provider is anonymous-only. Every button returns to
// `backTo()` after signing in.
const { loginOptions } = useLoginOptions({ returnTo: backTo })
const { workspaceSso } = useInstanceConfig()

// "Sign in with your organisation": a work email → the SSO link of
// the workspace that verified its domain. Only where per-workspace SSO
// can exist on this instance.
const ssoOpen = ref(false)
const ssoEmailId = useId()
// The field appears on click, so focus moves to it by hand (`autofocus` only runs on page load).
function openSso(): void {
  ssoOpen.value = true
  void nextTick(() => document.getElementById(ssoEmailId)?.focus())
}
const ssoEmail = ref('')
const ssoBusy = ref(false)
const ssoError = ref<string | null>(null)

async function continueWithSso(): Promise<void> {
  if (!ssoEmail.value.trim() || ssoBusy.value) return
  ssoBusy.value = true
  ssoError.value = null
  try {
    const res = await apiFetch('/api/auth/sso/discover', {
      method: 'post',
      body: { email: ssoEmail.value, returnTo: backTo() }
    })
    globalThis.location.href = res.loginUrl
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    ssoError.value = status === 404 ? t('sso.discover.notFound') : t('sso.discover.failed')
    ssoBusy.value = false
  }
}
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
    <template v-if="workspaceSso">
      <UButton
        v-if="!ssoOpen"
        icon="i-lucide-key-round"
        color="neutral"
        variant="ghost"
        block
        data-testid="login-sso"
        @click="openSso"
      >
        {{ t('sso.discover.button') }}
      </UButton>
      <form
        v-else
        class="flex flex-col gap-2"
        data-testid="login-sso-form"
        @submit.prevent="continueWithSso"
      >
        <UInput
          :id="ssoEmailId"
          v-model="ssoEmail"
          type="email"
          autocomplete="email"
          :placeholder="t('sso.discover.placeholder')"
          data-testid="login-sso-email"
        />
        <UButton
          type="submit"
          color="neutral"
          block
          :loading="ssoBusy"
          data-testid="login-sso-continue"
        >
          {{ t('sso.discover.continue') }}
        </UButton>
        <p
          v-if="ssoError"
          class="text-xs text-muted"
          data-testid="login-sso-error"
        >
          {{ ssoError }}
        </p>
      </form>
    </template>
    <p
      v-if="loginOptions.length === 0 && !workspaceSso"
      class="text-xs text-muted"
      data-testid="login-unavailable"
    >
      {{ t('auth.loginUnavailable') }}
    </p>
  </div>
</template>
