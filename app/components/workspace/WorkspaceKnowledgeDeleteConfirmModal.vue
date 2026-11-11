<script setup lang="ts">
// Knowledge-file delete confirmation. Like DeleteConfirmModal but without
// the "type the name" step: knowledge files are uploaded artifacts, not
// user-authored content. The red icon + warning copy still frame it as
// destructive.

const props = defineProps<{
  workspaceId: string
  knowledgeId: string
  filename: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  deleted: []
}>()

const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

const deleting = ref(false)

async function handleDelete() {
  deleting.value = true
  try {
    await apiFetch('/api/workspaces/:wsId/knowledge/:knowledgeId', {
      method: 'delete',
      path: { wsId: props.workspaceId, knowledgeId: props.knowledgeId }
    })
    toast.add({
      title: t('knowledge.deleted'),
      description: props.filename,
      icon: 'i-lucide-check-circle',
      color: 'success'
    })
    open.value = false
    emit('deleted')
  } catch (e) {
    showError('knowledge.deleteFailed', e)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('knowledge.deleteTitle')"
  >
    <template #content>
      <div class="p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-trash-2"
              class="size-5 text-red-500"
            />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-semibold">
              {{ t('knowledge.deleteTitle') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{ t('knowledge.deleteWarning') }}
            </p>
          </div>
        </div>

        <div class="bg-red-500/5 border border-red-500/20 rounded-lg p-3 mb-4">
          <p class="text-sm font-medium truncate">
            {{ filename }}
          </p>
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="deleting"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="error"
            :loading="deleting"
            icon="i-lucide-trash-2"
            @click="handleDelete"
          >
            {{ t('knowledge.deleteConfirm') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
