<script setup lang="ts">
// Pre-deletion consequence modal. Pulls /api/user/me/deletion-preview
// when opened so the rendered text reflects live state — names of
// workspaces that will cascade vs the names of members who will be
// promoted, etc. Requires the user to type a magic phrase before
// the destructive action enables.
//
// Once the user submits, POST /api/user/me/delete schedules the
// deletion (30-day grace begins). The grace banner takes over from
// here as the persistent visible signal.

interface OwnedDoc {
  docId: string
  title: string
  accessMode: string
  workspaceId: string | null
}

type WorkspaceFate
  = | { kind: 'cascade_delete', workspaceId: string, name: string, docCount: number, knowledgeCount: number }
    | { kind: 'promote_admin', workspaceId: string, name: string, newAdminUserId: number, newAdminName: string, newAdminPreviousRole: 'admin' | 'editor' | 'viewer' }
    | { kind: 'remove_member', workspaceId: string, name: string, currentRole: 'admin' | 'editor' | 'viewer' }

interface DeletionPreview {
  userId: number
  ownedDocs: { total: number, sample: OwnedDoc[] }
  commentsToAnonymise: number
  workspaces: WorkspaceFate[]
  aiUsage: { sessions: number, sessionMessages: number }
  dataExportJobs: number
  stripeCustomerWillBeDeleted: boolean
  retainedAnonymised: { activityLog: number, auditLog: number, consentLog: number }
}

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  scheduled: []
}>()

const { t } = useI18n()
const toast = useToast()
const { refresh: refreshAccountStatus } = useAccountStatus()

const preview = ref<DeletionPreview | null>(null)
const previewLoading = ref(false)
const previewError = ref<string | null>(null)

const submitting = ref(false)
const confirmInput = ref('')

const CONFIRM_PHRASE = 'delete my account'
const phraseMatches = computed(() => confirmInput.value.trim().toLowerCase() === CONFIRM_PHRASE)

watch(open, async (isOpen) => {
  if (!isOpen) {
    preview.value = null
    previewError.value = null
    confirmInput.value = ''
    return
  }
  previewLoading.value = true
  try {
    preview.value = await $fetch<DeletionPreview>('/api/user/deletion-preview')
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    previewError.value = err.data?.message ?? err.message ?? 'Could not load deletion preview'
  } finally {
    previewLoading.value = false
  }
})

const cascadeRows = computed(() =>
  (preview.value?.workspaces ?? []).filter(w => w.kind === 'cascade_delete')
)
const promoteRows = computed(() =>
  (preview.value?.workspaces ?? []).filter(w => w.kind === 'promote_admin')
)
const removeMemberRows = computed(() =>
  (preview.value?.workspaces ?? []).filter(w => w.kind === 'remove_member')
)

async function onConfirm(): Promise<void> {
  if (!phraseMatches.value || submitting.value) return
  submitting.value = true
  try {
    await $fetch('/api/user/delete', { method: 'POST' })
    await refreshAccountStatus()
    toast.add({
      title: t('legal.delete.graceBannerTitle'),
      description: '',
      icon: 'i-lucide-clock',
      color: 'neutral'
    })
    open.value = false
    emit('scheduled')
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not schedule deletion',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('legal.delete.consequences.title')"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #content>
      <!-- Flex column with a viewport-capped max-height. Header is
           shrink-0 (always visible at the top), preview area
           flex-grows + scrolls, confirm row is shrink-0 (always
           visible at the bottom). On mobile the cap matters most:
           with the old fixed `max-h-[60vh]` on the inner scroller,
           the confirm submit button slipped off the 667-tall
           viewport and was barely tappable. -->
      <div
        class="flex flex-col p-6 max-h-[85vh]"
        data-testid="deletion-consequences-modal"
      >
        <div class="flex items-start gap-3 mb-4 shrink-0">
          <div class="size-10 rounded-full bg-rose-500/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-trash-2"
              class="size-5 text-rose-500"
            />
          </div>
          <div class="flex-1">
            <h2 class="font-serif text-xl font-normal tracking-tight">
              {{ t('legal.delete.consequences.title') }}
            </h2>
            <p class="text-sm text-muted mt-1">
              {{ t('legal.delete.consequences.intro') }}
            </p>
          </div>
        </div>

        <!-- Loading + error states -->
        <div
          v-if="previewLoading"
          class="text-sm text-muted py-6 text-center"
        >
          <UIcon
            name="i-lucide-loader-2"
            class="size-5 animate-spin mb-2 mx-auto"
          />
          Reading your account…
        </div>
        <div
          v-else-if="previewError"
          class="text-sm text-rose-700 dark:text-rose-300 py-6 text-center"
        >
          {{ previewError }}
        </div>

        <div
          v-else-if="preview"
          class="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1"
        >
          <!-- Permanently deleted -->
          <section>
            <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('legal.delete.consequences.deleted.heading') }}
            </h3>
            <ul class="text-sm space-y-1 list-disc pl-5">
              <li>{{ t('legal.delete.consequences.deleted.ownedDocs', { count: preview.ownedDocs.total }) }}</li>
              <li>{{ t('legal.delete.consequences.deleted.themes') }}</li>
              <li>{{ t('legal.delete.consequences.deleted.ai') }}</li>
              <li v-if="preview.dataExportJobs > 0">
                {{ t('legal.delete.consequences.deleted.exports', { count: preview.dataExportJobs }) }}
              </li>
              <li v-if="preview.stripeCustomerWillBeDeleted">
                {{ t('legal.delete.consequences.deleted.stripe') }}
              </li>
            </ul>
          </section>

          <!-- Workspaces — the load-bearing transparency section -->
          <section v-if="preview.workspaces.length > 0">
            <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('legal.delete.consequences.workspaces.heading') }}
            </h3>

            <div
              v-if="cascadeRows.length > 0"
              class="mb-3 rounded border border-rose-500/30 bg-rose-500/5 p-3"
              data-testid="ws-cascade-block"
            >
              <p class="text-sm font-medium mb-1">
                {{ t('legal.delete.consequences.workspaces.cascadeDelete.title') }}
              </p>
              <p class="text-xs text-muted mb-2">
                {{ t('legal.delete.consequences.workspaces.cascadeDelete.body') }}
              </p>
              <ul class="text-xs space-y-1 font-mono">
                <li
                  v-for="ws in cascadeRows"
                  :key="ws.workspaceId"
                >
                  {{ t('legal.delete.consequences.workspaces.cascadeDelete.row', {
                    name: ws.name,
                    docCount: ws.docCount,
                    knowledgeCount: ws.knowledgeCount
                  }) }}
                </li>
              </ul>
            </div>

            <div
              v-if="promoteRows.length > 0"
              class="mb-3 rounded border border-default p-3"
              data-testid="ws-promote-block"
            >
              <p class="text-sm font-medium mb-1">
                {{ t('legal.delete.consequences.workspaces.promote.title') }}
              </p>
              <p class="text-xs text-muted mb-2">
                {{ t('legal.delete.consequences.workspaces.promote.body') }}
              </p>
              <ul class="text-xs space-y-1 font-mono">
                <li
                  v-for="ws in promoteRows"
                  :key="ws.workspaceId"
                >
                  {{ t('legal.delete.consequences.workspaces.promote.row', {
                    name: ws.name,
                    newAdminName: ws.kind === 'promote_admin' ? ws.newAdminName : '',
                    newAdminPreviousRole: ws.kind === 'promote_admin' ? ws.newAdminPreviousRole : ''
                  }) }}
                </li>
              </ul>
            </div>

            <div
              v-if="removeMemberRows.length > 0"
              class="mb-3 rounded border border-default p-3"
              data-testid="ws-remove-block"
            >
              <p class="text-sm font-medium mb-1">
                {{ t('legal.delete.consequences.workspaces.removeMember.title') }}
              </p>
              <p class="text-xs text-muted mb-2">
                {{ t('legal.delete.consequences.workspaces.removeMember.body') }}
              </p>
              <ul class="text-xs space-y-1 font-mono">
                <li
                  v-for="ws in removeMemberRows"
                  :key="ws.workspaceId"
                >
                  {{ t('legal.delete.consequences.workspaces.removeMember.row', {
                    name: ws.name,
                    currentRole: ws.kind === 'remove_member' ? ws.currentRole : ''
                  }) }}
                </li>
              </ul>
            </div>
          </section>

          <!-- Anonymised -->
          <section>
            <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('legal.delete.consequences.anonymised.heading') }}
            </h3>
            <ul class="text-sm space-y-1 list-disc pl-5">
              <li v-if="preview.commentsToAnonymise > 0">
                {{ t('legal.delete.consequences.anonymised.comments', { count: preview.commentsToAnonymise }) }}
              </li>
              <li>{{ t('legal.delete.consequences.anonymised.activity', { count: preview.retainedAnonymised.activityLog }) }}</li>
              <li>{{ t('legal.delete.consequences.anonymised.audit', { count: preview.retainedAnonymised.auditLog }) }}</li>
              <li>{{ t('legal.delete.consequences.anonymised.consent', { count: preview.retainedAnonymised.consentLog }) }}</li>
            </ul>
          </section>

          <!-- Manual steps + timing -->
          <section>
            <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('legal.delete.consequences.manualSteps.heading') }}
            </h3>
            <ul class="text-sm space-y-1 list-disc pl-5">
              <li>{{ t('legal.delete.consequences.manualSteps.exportFirst') }}</li>
              <li>{{ t('legal.delete.consequences.manualSteps.transferDocs') }}</li>
              <li>{{ t('legal.delete.consequences.manualSteps.inviteWorkspaceMember') }}</li>
              <li>{{ t('legal.delete.consequences.manualSteps.downloadKnowledge') }}</li>
            </ul>
          </section>

          <p class="text-xs text-muted">
            {{ t('legal.delete.consequences.timing') }}
          </p>
          <p class="text-xs text-rose-700 dark:text-rose-300">
            {{ t('legal.delete.consequences.noRecovery') }}
          </p>
        </div>

        <!-- Confirm gate. shrink-0 keeps it visible at the bottom of
             the modal regardless of how long the consequence preview
             is — without this the row would collapse off-screen on
             mobile (the modal flex-column caps at 85vh). -->
        <div class="mt-6 pt-4 border-t border-default shrink-0">
          <label class="block text-sm mb-2">
            {{ t('legal.delete.confirmTypeIn', { phrase: CONFIRM_PHRASE }) }}
          </label>
          <UInput
            v-model="confirmInput"
            :placeholder="CONFIRM_PHRASE"
            class="w-full font-mono"
            data-testid="deletion-confirm-input"
            autocomplete="off"
            spellcheck="false"
          />
          <!-- Buttons stack on mobile (Schedule on top because it's
               the answer to the typed phrase; Cancel below as the
               escape hatch). On `sm+` they sit side-by-side aligned
               to the right like the rest of our modal CTAs. -->
          <div class="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end mt-4">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="submitting"
              block
              class="sm:!w-auto"
              @click="open = false"
            >
              {{ t('legal.delete.confirmCancel') }}
            </UButton>
            <UButton
              color="error"
              :loading="submitting"
              :disabled="!phraseMatches"
              icon="i-lucide-trash-2"
              block
              class="sm:!w-auto"
              data-testid="deletion-confirm-submit"
              @click="onConfirm"
            >
              {{ t('legal.delete.confirmCta') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
