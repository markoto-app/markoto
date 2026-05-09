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

function restoreErrorTitleKey(status: number | undefined): string {
  if (status === 403) return 'activity.restore.error.unauthorized'
  if (status === 410) return 'activity.restore.error.unavailable'
  if (status === 404) return 'activity.restore.error.notFound'
  return 'activity.restore.error.generic'
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
    const titleKey = restoreErrorTitleKey(err.statusCode)
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
        <!--
          Restore-confirm dialog. Restore is a chrome action, not AI
          presence — palette stays sumi-neutral (bg-elevated puck,
          text-toned icon, hairline-bordered info card). CTA is a
          neutral solid (sumi-950 light / sumi-50 dark) rather than
          the previous color=info blue.
        -->
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
