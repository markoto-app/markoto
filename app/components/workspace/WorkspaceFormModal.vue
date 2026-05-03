<script setup lang="ts">
// One modal for both create and edit — the shapes match (name + optional
// description) and the UX should too. Mode is implied by `workspaceId`:
// present → edit (PUT), absent → create (POST).

const props = defineProps<{
  workspaceId?: string
  initialName?: string
  initialDescription?: string | null
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  created: [workspaceId: string]
  updated: [payload: { name: string, description: string | null }]
}>()

const { t } = useI18n()
const toast = useToast()

const name = ref('')
const description = ref('')
const saving = ref(false)

const isEdit = computed(() => !!props.workspaceId)
const canSubmit = computed(() => name.value.trim().length > 0 && !saving.value)

watch(open, (v) => {
  if (v) {
    name.value = props.initialName ?? ''
    description.value = props.initialDescription ?? ''
  }
})

async function handleSubmit() {
  if (!canSubmit.value) return
  saving.value = true
  const payload = {
    name: name.value.trim(),
    description: description.value.trim() || null
  }
  try {
    if (isEdit.value) {
      await $fetch(`/api/workspaces/${props.workspaceId}`, { method: 'PUT', body: payload })
      emit('updated', payload)
    } else {
      const res = await $fetch<{ workspaceId: string }>('/api/workspaces', { method: 'POST', body: payload })
      emit('created', res.workspaceId)
    }
    open.value = false
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: isEdit.value ? t('workspace.saveFailed') : t('workspace.createFailed'),
      description: err?.data?.message || err?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? t('workspace.editTitle') : t('workspace.createTitle')"
    :description="isEdit ? '' : t('workspace.createDescription')"
  >
    <template #body>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('workspace.nameLabel') }}</label>
          <UInput
            v-model="name"
            :placeholder="t('workspace.namePlaceholder')"
            size="md"
            class="w-full"
            :ui="{ base: 'w-full' }"
            autofocus
            data-testid="workspace-form-name"
            @keydown.enter="handleSubmit"
          />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">{{ t('workspace.descriptionOptional') }}</label>
          <UTextarea
            v-model="description"
            :placeholder="t('workspace.descriptionPlaceholder')"
            :rows="3"
            class="w-full"
            :ui="{ base: 'w-full' }"
            data-testid="workspace-form-description"
          />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex gap-2 justify-end w-full">
        <UButton
          variant="ghost"
          :disabled="saving"
          @click="open = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          color="primary"
          :loading="saving"
          :disabled="!canSubmit"
          :icon="isEdit ? 'i-lucide-check' : 'i-lucide-plus'"
          data-testid="workspace-form-submit"
          @click="handleSubmit"
        >
          {{ isEdit ? t('common.save') : t('workspace.create') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
