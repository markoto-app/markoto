<script setup lang="ts">
// Sync problems. Two need a reload: the handshake was rejected (distinct
// from ordinary read-only states: explains why edit access vanished), or
// the server refused an update (the editor stays editable, but nothing is
// saved until a reload). The third resolves itself: the sync server is at
// a capacity limit and the connection retries with backoff.
defineProps<{
  syncAuthFailed: boolean
  syncRejectionMessage: string | null
  syncBusy: boolean
}>()
const { t } = useI18n()
</script>

<template>
  <!-- Sync handshake rejected. Distinct from ordinary read-only states
       (workspace viewer, password gate); explains why edit access vanished. -->
  <div
    v-if="syncAuthFailed"
    class="border-b border-error bg-error/10 text-error px-4 py-2 flex items-center gap-3 text-sm"
    role="alert"
  >
    <UIcon
      name="i-lucide-shield-alert"
      class="size-4 shrink-0"
    />
    <div class="flex-1 min-w-0">
      <span class="font-medium">{{ t('editor.syncAuthFailedTitle') }}</span>
      <span class="ml-2 text-xs opacity-80">{{ t('editor.syncAuthFailedDescription') }}</span>
    </div>
    <UButton
      size="xs"
      color="error"
      variant="solid"
      icon="i-lucide-rotate-ccw"
      @click="$router.go(0)"
    >
      {{ t('editor.syncAuthFailedReload') }}
    </UButton>
  </div>

  <!-- Capacity limit on the sync server: not an access problem, the
       connection retries by itself. -->
  <div
    v-if="syncBusy && !syncAuthFailed && !syncRejectionMessage"
    class="border-b border-warning bg-warning/10 text-warning px-4 py-2 flex items-center gap-3 text-sm"
    role="status"
    data-testid="sync-busy-banner"
  >
    <UIcon
      name="i-lucide-loader-circle"
      class="size-4 shrink-0 animate-spin"
    />
    <div class="flex-1 min-w-0">
      <span class="font-medium">{{ t('editor.syncBusy.title') }}</span>
      <span class="ml-2 text-xs opacity-80">{{ t('editor.syncBusy.description') }}</span>
    </div>
  </div>

  <!-- The server refused an update (too large, invalid document setting).
       Unlike the auth banner the editor stays editable, but nothing is
       saved until a reload. -->
  <div
    v-if="syncRejectionMessage"
    class="border-b border-error bg-error/10 text-error px-4 py-2 flex items-center gap-3 text-sm"
    role="alert"
    data-testid="sync-rejection-banner"
  >
    <UIcon
      name="i-lucide-cloud-off"
      class="size-4 shrink-0"
    />
    <div class="flex-1 min-w-0">
      <span class="font-medium">{{ t('editor.syncRejected.title') }}</span>
      <span class="ml-2 text-xs opacity-80">{{ syncRejectionMessage }}</span>
    </div>
    <UButton
      size="xs"
      color="error"
      variant="solid"
      icon="i-lucide-rotate-ccw"
      @click="$router.go(0)"
    >
      {{ t('editor.syncAuthFailedReload') }}
    </UButton>
  </div>
</template>
