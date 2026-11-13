<script setup lang="ts">
// No access: a private document opened by a non-owner, an expired share
// link, or a workspace that requires single sign-on. Short-circuits before
// any editor chrome: no token was fetched and there is no Y.Doc content.
defineProps<{
  shareExpired: boolean
  /** Where to sign in when the document's workspace enforces single sign-on. */
  ssoLoginUrl: string | null
}>()
const { t } = useI18n()
const { loggedIn } = useUserSession()
const { primaryLoginPath } = useInstanceConfig()
</script>

<template>
  <div
    class="h-dvh flex items-center justify-center p-6 bg-[var(--ui-bg)]"
  >
    <div class="max-w-md w-full text-center space-y-4">
      <div class="mx-auto size-14 rounded-full bg-amber-500/10 flex items-center justify-center">
        <UIcon
          name="i-lucide-lock-keyhole"
          class="size-7 text-amber-500"
        />
      </div>
      <h1 class="text-xl font-semibold">
        {{ shareExpired ? t('share.controls.expiredTitle') : t('access.privateTitle') }}
      </h1>
      <p class="text-sm text-muted">
        {{ shareExpired ? t('share.controls.expiredBody') : ssoLoginUrl ? t('sso.requiredBody') : loggedIn ? t('access.privateDescLoggedIn') : t('access.privateDescAnon') }}
      </p>
      <div class="flex justify-center gap-2 pt-2">
        <UButton
          variant="soft"
          @click="navigateTo('/')"
        >
          {{ t('access.backHome') }}
        </UButton>
        <UButton
          v-if="!loggedIn && primaryLoginPath"
          color="primary"
          @click="navigateTo(primaryLoginPath, { external: true })"
        >
          {{ t('auth.login') }}
        </UButton>
        <!-- The doc's workspace enforces single sign-on. -->
        <UButton
          v-if="ssoLoginUrl"
          color="neutral"
          icon="i-lucide-key-round"
          data-testid="doc-sso-sign-in"
          @click="navigateTo(ssoLoginUrl, { external: true })"
        >
          {{ t('sso.signIn') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
