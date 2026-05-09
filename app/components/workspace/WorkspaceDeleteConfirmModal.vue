<script setup lang="ts">
const props = defineProps<{
  workspaceId: string
  name: string
  docCount: number
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  deleted: []
}>()

const { t } = useI18n()
const toast = useToast()

const deleting = ref(false)
const confirmText = ref('')
const canConfirm = computed(() => confirmText.value === props.name)

async function handleDelete() {
  if (!canConfirm.value) return
  deleting.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}`, { method: 'DELETE' })
    toast.add({
      title: t('workspace.deleteSuccess'),
      icon: 'i-lucide-check-circle',
      color: 'success'
    })
    open.value = false
    emit('deleted')
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('workspace.deleteFailed'),
      description: err?.data?.message || err?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}

watch(open, (v) => {
  if (v) confirmText.value = ''
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('workspace.deleteTitle')"
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
              {{ t('workspace.deleteTitle') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{
                docCount > 0
                  ? t('workspace.deleteWarning', docCount, { named: { count: docCount } })
                  : t('workspace.deleteWarningEmpty')
              }}
            </p>
          </div>
        </div>

        <div class="bg-red-500/5 border border-red-500/20 rounded-lg p-3 mb-4">
          <p class="text-sm font-medium">
            {{ name }}
          </p>
        </div>

        <div class="mb-4">
          <label
            for="workspace-delete-confirm"
            class="block text-sm font-medium mb-2"
          >
            {{ t('workspace.deleteConfirmPrompt', { name }) }}
          </label>
          <UInput
            id="workspace-delete-confirm"
            v-model="confirmText"
            :placeholder="name"
            size="md"
            class="w-full"
            :ui="{ base: 'w-full' }"
            @keydown.enter="handleDelete"
          />
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
            :disabled="!canConfirm"
            icon="i-lucide-trash-2"
            @click="handleDelete"
          >
            {{ t('workspace.deleteConfirm') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
