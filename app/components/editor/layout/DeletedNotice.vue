<script setup lang="ts">
// Someone else deleted the open document (its owner, a workspace admin, a
// folder or bulk delete): the text stays readable in the editor; this offers
// a Markdown copy before the person leaves.

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ download: [] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('delete.remoteTitle')"
  >
    <template #body>
      <p
        class="text-sm"
        data-testid="doc-deleted-notice"
      >
        {{ t('delete.remoteDesc') }}
      </p>
    </template>
    <template #footer>
      <div class="flex flex-wrap justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          {{ t('delete.keepReading') }}
        </UButton>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-house"
          to="/"
        >
          {{ t('access.backHome') }}
        </UButton>
        <UButton
          color="neutral"
          icon="i-lucide-download"
          data-testid="doc-deleted-download"
          @click="emit('download')"
        >
          {{ t('delete.downloadCopy') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
