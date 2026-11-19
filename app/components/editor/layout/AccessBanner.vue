<script setup lang="ts">
// The strip under the editor's toolbar when the person can't edit: the
// document was deleted by someone else (its text stays readable, a Markdown
// copy is one click away) or they only have view access.

defineProps<{ deleted: boolean, readOnly: boolean }>()
const emit = defineEmits<{ download: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="deleted"
    class="bg-error/10 border-b border-error/30 px-4 py-1.5 text-sm text-error flex flex-wrap items-center justify-center gap-x-3 gap-y-1"
    data-testid="doc-deleted-banner"
  >
    <span>
      <UIcon
        name="i-lucide-trash-2"
        class="size-3.5 mr-1 align-text-bottom"
      />
      {{ t('delete.remoteBanner') }}
    </span>
    <UButton
      size="xs"
      color="error"
      variant="link"
      icon="i-lucide-download"
      class="p-0"
      @click="emit('download')"
    >
      {{ t('delete.downloadCopy') }}
    </UButton>
  </div>
  <div
    v-else-if="readOnly"
    class="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-center text-sm text-amber-600 dark:text-amber-400"
  >
    <UIcon
      name="i-lucide-lock"
      class="size-3.5 mr-1 align-text-bottom"
    />
    {{ t('share.viewOnly') }}
  </div>
</template>
