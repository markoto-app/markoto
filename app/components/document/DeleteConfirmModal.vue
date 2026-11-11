<script setup lang="ts">
const props = defineProps<{
  docId: string
  title: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  // Fired right before the DELETE request, and `failed` when it errors —
  // lets the editor tell its own deletion apart from someone else's
  // (the sync broadcast can arrive before the response).
  deleting: []
  failed: []
  deleted: []
}>()

const { t } = useI18n()
const toast = useToast()
// Mobile haptic on delete-confirm tap. Double-pulse pattern reinforces
// "intentional, irreversible" — distinct from a casual click. iOS has
// no Web Vibration API, so isSupported is false there and vibrate()
// silently no-ops; safe to call unconditionally. Pattern passed at
// call time rather than via options because the upstream
// `UseVibrateOptions.interval` field is non-optional in the .d.ts.
const { vibrate } = useVibrate()

const deleting = ref(false)
const confirmText = ref('')

// Require the user to type the document title to confirm deletion.
// This prevents accidental clicks and forces deliberate intent.
const canConfirm = computed(() => confirmText.value === props.title)

async function handleDelete() {
  if (!canConfirm.value) return
  vibrate([100, 30, 100])
  deleting.value = true
  emit('deleting')
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
  } catch (e) {
    emit('failed')
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('delete.failed'),
      description: err.data?.message || err.message,
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
            <UIcon
              name="i-lucide-trash-2"
              class="size-5 text-red-500"
            />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-semibold">
              {{ t('delete.title') }}
            </h2>
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
          <label
            for="delete-confirm-input"
            class="block text-sm font-medium mb-2"
          >
            {{ t('delete.confirmPrompt', { title }) }}
          </label>
          <UInput
            id="delete-confirm-input"
            v-model="confirmText"
            :placeholder="title"
            size="md"
            class="w-full"
            :ui="{ base: 'w-full' }"
            data-testid="delete-confirm-input"
            @keydown.enter="handleDelete"
          />
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="deleting"
            data-testid="delete-cancel"
            @click="handleClose"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="error"
            :loading="deleting"
            :disabled="!canConfirm"
            icon="i-lucide-trash-2"
            data-testid="delete-confirm"
            @click="handleDelete"
          >
            {{ t('delete.confirm') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
