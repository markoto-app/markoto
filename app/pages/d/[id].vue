<script setup lang="ts">
const { t } = useI18n()
const route = useRoute()
const docId = route.params.id as string
</script>

<template>
  <ClientOnly>
    <EditorLayout :doc-id="docId" />
    <template #fallback>
      <div class="h-screen flex items-center justify-center">
        <div class="text-center space-y-3">
          <UIcon
            name="i-lucide-loader"
            class="size-8 animate-spin text-primary mx-auto"
          />
          <p class="text-sm text-muted">
            {{ t('common.loading') }}
          </p>
        </div>
      </div>
    </template>
  </ClientOnly>
</template>
