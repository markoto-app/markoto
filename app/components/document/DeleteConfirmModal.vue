<script setup lang="ts">
const props = defineProps<{
  docId: string
  title: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  deleted: []
}>()

const { t } = useI18n()
const toast = useToast()

const deleting = ref(false)
const confirmText = ref('')

// Require the user to type the document title to confirm deletion.
// This prevents accidental clicks and forces deliberate intent.
const canConfirm = computed(() => confirmText.value === props.title)

async function handleDelete() {
  if (!canConfirm.value) return
  deleting.value = true
  try {
    await $fetch(`/api/docs/${props.docId}`, { method: 'DELETE' })
    toast.add({
      title: t('delete.success'),
      description: t('delete.successDesc', { title: props.title }),
      icon: 'i-lucide-check-circle',
      color: 'success'
    })
    open.value = false
    emit('deleted')
  } catch (e: any) {
    toast.add({
      title: t('delete.failed'),
      description: e.data?.message || e.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}

function handleClose() {
  confirmText.value = ''
  open.value = false
}

// Reset input when modal opens
watch(open, (v) => {
  if (v) confirmText.value = ''
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('delete.title')"
  >
    <template #content>
      <div class="p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
            <UIcon name="i-lucide-trash-2" class="size-5 text-red-500" />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-semibold">{{ t('delete.title') }}</h2>
            <p class="text-sm text-muted mt-1">
              {{ t('delete.warning') }}
            </p>
          </div>
        </div>

        <div class="bg-red-500/5 border border-red-500/20 rounded-lg p-3 mb-4">
          <p class="text-sm">
            <span class="text-muted">{{ t('delete.document') }}:</span>
            <span class="font-medium ml-1">{{ title }}</span>
          </p>
        </div>

        <div class="mb-4">
          <label class="block text-sm font-medium mb-2">
            {{ t('delete.confirmPrompt', { title }) }}
          </label>
          <UInput
            v-model="confirmText"
            :placeholder="title"
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
            @click="handleClose"
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
            {{ t('delete.confirm') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
