<script setup lang="ts">
// The token endpoint 404'd: the document doesn't exist. Without this
// screen the empty token leaves the provider unable to connect and the user
// sees a misleading "disconnected / view only" editor.
const { t } = useI18n()
</script>

<template>
  <div
    class="h-dvh flex items-center justify-center p-6 bg-[var(--ui-bg)]"
  >
    <div class="max-w-md w-full text-center space-y-4">
      <div class="mx-auto size-14 rounded-full bg-muted flex items-center justify-center">
        <UIcon
          name="i-lucide-file-question"
          class="size-7 text-muted"
        />
      </div>
      <h1 class="text-xl font-semibold">
        {{ t('access.notFoundTitle') }}
      </h1>
      <p class="text-sm text-muted">
        {{ t('access.notFoundDesc') }}
      </p>
      <div class="flex justify-center gap-2 pt-2">
        <UButton
          variant="soft"
          @click="navigateTo('/')"
        >
          {{ t('access.backHome') }}
        </UButton>
      </div>
    </div>
  </div>
</template>
