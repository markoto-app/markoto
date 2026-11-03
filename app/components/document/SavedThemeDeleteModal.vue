<script setup lang="ts">
// Delete confirmation for a saved theme. Same idiom as
// DeleteConfirmModal / WorkspaceKnowledgeDeleteConfirmModal without the
// "type the name" step: a saved theme is a settings bookmark, and the
// documents that use it keep their own copy. The error colour sits only
// on the destructive pieces (icon disc, the confirm button).

const props = defineProps<{
  themeId: string
  name: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{ deleted: [] }>()

const { t } = useI18n()
const toast = useToast()

const deleting = ref(false)

async function handleDelete() {
  if (deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/themes/${props.themeId}`, { method: 'DELETE' })
    toast.add({
      title: t('theme.saved.deleted'),
      description: props.name,
      icon: 'i-lucide-check-circle',
      color: 'success'
    })
    open.value = false
    emit('deleted')
  } catch (e) {
    const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
    toast.add({
      title: t('theme.saved.deleteFailedTitle'),
      description: err.data?.message ?? err.statusMessage ?? err.message ?? '',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('theme.saved.deleteTitle')"
    :description="t('theme.saved.deleteWarning')"
  >
    <template #content>
      <div
        class="p-6"
        data-testid="saved-theme-delete-modal"
      >
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-error/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-trash-2"
              class="size-5 text-error"
            />
          </div>
          <div class="flex-1 min-w-0">
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('theme.saved.deleteTitle') }}
            </h2>
            <p class="text-sm text-muted mt-1 leading-relaxed">
              {{ t('theme.saved.deleteWarning') }}
            </p>
          </div>
        </div>

        <div class="rounded-md border border-default bg-elevated px-3 py-2.5 mb-5">
          <p class="font-serif text-base tracking-tight truncate">
            {{ name }}
          </p>
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="deleting"
            data-testid="saved-theme-delete-cancel"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="error"
            :loading="deleting"
            icon="i-lucide-trash-2"
            data-testid="saved-theme-delete-confirm"
            @click="handleDelete"
          >
            {{ t('theme.saved.deleteConfirmButton') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
