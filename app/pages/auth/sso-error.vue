<script setup lang="ts">
// Where a refused or failed single sign-on lands (WP14). The server only
// ever passes one of our fixed codes (`server/utils/sso/completeLogin.ts`
// + the callback routes) — never text from the identity provider.
const { t } = useI18n()
const route = useRoute()

const KNOWN = new Set([
  'sso/not-provisioned', 'sso/deactivated', 'sso/not-active', 'sso/test-not-admin', 'sso/test-mismatch',
  'sso/no-seat', 'sso/member-limit', 'sso/idp-unavailable', 'sso/failed', 'sso/unknown'
])
const code = computed(() => {
  const raw = typeof route.query.code === 'string' ? route.query.code : ''
  return KNOWN.has(raw) ? raw.replace('sso/', '') : 'failed'
})
const workspaceId = computed(() => typeof route.query.workspace === 'string' && /^[\w-]{1,64}$/.test(route.query.workspace) ? route.query.workspace : null)

useHead({ title: () => t('sso.error.title') })
definePageMeta({ layout: false })
</script>

<template>
  <div class="min-h-dvh flex items-center justify-center p-6 bg-muted">
    <div
      class="max-w-md w-full text-center space-y-4"
      data-testid="sso-error"
      :data-code="code"
    >
      <UIcon
        name="i-lucide-key-round"
        class="size-10 text-muted mx-auto"
      />
      <h1 class="font-serif text-2xl font-normal tracking-tight">
        {{ t('sso.error.title') }}
      </h1>
      <p class="text-sm text-muted">
        {{ t(`sso.error.${code}`) }}
      </p>
      <div class="flex justify-center gap-2 pt-2">
        <UButton
          to="/"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
        >
          {{ t('access.backHome') }}
        </UButton>
        <UButton
          v-if="workspaceId"
          :to="`/w/${workspaceId}`"
          color="neutral"
          variant="outline"
        >
          {{ t('sso.error.toWorkspace') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
