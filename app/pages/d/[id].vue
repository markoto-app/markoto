<script setup lang="ts">
const { t } = useI18n()
const route = useRoute()
const docId = route.params.id as string
// User documents stay out of search engines (the server also sends
// X-Robots-Tag on /d/**, see server/utils/platform/robots.ts).
useSeoMeta({ robots: 'noindex, nofollow' })
</script>

<template>
  <ClientOnly>
    <EditorLayout :doc-id="docId" />
    <template #fallback>
      <div class="h-dvh flex items-center justify-center">
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
