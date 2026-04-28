<script setup lang="ts">
// Confirmation modal for "Restore the document to this point."
// Restore is reversible (the resulting `restore` activity row is
// itself restorable, snapping back to the pre-restore state), so we
// deliberately don't gate this with the type-the-doc-name pattern
// from DeleteConfirmModal — the friction is unwarranted. Just a
// clear preview + Cancel/Restore.

const props = defineProps<{
  docId: string
  /** The activity row id we're restoring FROM (the row whose
   *  yjsDocIdBefore the doc will snap to). */
  activityId: number
  /** Human-readable timestamp / relative time of the source activity
   *  row. Surfaces as part of the body text so the user understands
   *  WHICH past state they're going back to. */
  whenLabel: string
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  restored: []
}>()

const { t } = useI18n()
const toast = useToast()

const restoring = ref(false)

interface RestoreResponse {
  ok: boolean
  restoredFromActivityId: number
  restoredFromTime: string
}

async function handleRestore() {
  restoring.value = true
  try {
    await $fetch<RestoreResponse>(
      `/api/docs/${props.docId}/activity/${props.activityId}/restore`,
      { method: 'POST' }
    )
    toast.add({
      title: t('activity.restore.success'),
      icon: 'i-lucide-history',
      color: 'success'
    })
    open.value = false
    emit('restored')
  } catch (e) {
    const err = e as { statusCode?: number, data?: { message?: string }, message?: string }
    // Per-status messaging — match the endpoint's contract from
    // server/api/docs/[docId]/activity/[activityId]/restore.post.ts.
    const status = err.statusCode
    const titleKey
      = status === 403 ? 'activity.restore.error.unauthorized'
      : status === 410 ? 'activity.restore.error.unavailable'
      : status === 404 ? 'activity.restore.error.notFound'
      : 'activity.restore.error.generic'
    toast.add({
      title: t(titleKey),
      description: err.data?.message || err.message,
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
        <div class="flex items-start gap-3 mb-4">
          <div class="size-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-history"
              class="size-5 text-blue-500"
            />
          </div>
          <div class="flex-1">
            <h2 class="text-lg font-semibold">
              {{ t('activity.restore.confirm.title') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{ t('activity.restore.confirm.body', { when: whenLabel }) }}
            </p>
          </div>
        </div>

        <div class="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3 mb-4 text-sm text-default">
          <UIcon
            name="i-lucide-info"
            class="size-4 text-blue-500 inline-block align-text-bottom mr-1.5"
          />
          {{ t('activity.restore.confirm.reversibleHint') }}
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="restoring"
            @click="handleClose"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="info"
            :loading="restoring"
            icon="i-lucide-history"
            @click="handleRestore"
          >
            {{ t('activity.restore.confirm.cta') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
