<script setup lang="ts">
// Confirmation modal for "Restore the document to this point." Restore is
// reversible (the resulting `restore` row is itself restorable), so it skips
// the type-the-name friction of DeleteConfirmModal.

const props = defineProps<{
  docId: string
  /** The activity row restored from (the doc snaps to its yjsDocIdBefore). */
  activityId: number
  /** Human-readable time of the source row, shown in the body text. */
  whenLabel: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  restored: []
}>()

const { t } = useI18n()
const toast = useToast()
const { extractError } = useErrorHandler()

const restoring = ref(false)

function restoreErrorTitleKey(status: number | null): string {
  if (status === 403) return 'activity.restore.error.unauthorized'
  if (status === 410) return 'activity.restore.error.unavailable'
  if (status === 404) return 'activity.restore.error.notFound'
  return 'activity.restore.error.generic'
}

async function handleRestore() {
  restoring.value = true

  try {
    await apiFetch('/api/docs/:docId/activity/:activityId/restore', {
      method: 'post',
      path: { docId: props.docId, activityId: props.activityId }
    })
    toast.add({
      title: t('activity.restore.success'),
      icon: 'i-lucide-history',
      color: 'success'
    })
    open.value = false
    emit('restored')
  } catch (e) {
    const err = extractError(e)
    // Status-specific messages follow the endpoint contract in
    // server/api/docs/[docId]/activity/[activityId]/restore.post.ts.
    const titleKey = restoreErrorTitleKey(err.statusCode)
    toast.add({
      title: t(titleKey),
      description: err.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    restoring.value = false
  }
}

function handleClose() {
  if (restoring.value) return // don't close mid-flight
  open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('activity.restore.confirm.title')"
  >
    <template #content>
      <div class="p-6">
        <!-- Restore is a chrome action, not AI presence: sumi-neutral palette and CTA. -->
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-elevated flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-history"
              class="size-5 text-toned"
            />
          </div>
          <div class="flex-1">
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('activity.restore.confirm.title') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{ t('activity.restore.confirm.body', { when: whenLabel }) }}
            </p>
          </div>
        </div>

        <div class="bg-muted border border-default/60 rounded-lg p-3 mb-4 text-sm text-default">
          <UIcon
            name="i-lucide-info"
            class="size-4 text-muted inline-block align-text-bottom mr-1.5"
          />
          {{ t('activity.restore.confirm.reversibleHint') }}
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="restoring"
            data-testid="restore-cancel"
            @click="handleClose"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="neutral"
            :loading="restoring"
            icon="i-lucide-history"
            data-testid="restore-confirm"
            @click="handleRestore"
          >
            {{ t('activity.restore.confirm.cta') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
