<script setup lang="ts">
// One modal for both create and edit, the shapes match (name + optional
// description) and the UX should too. Mode is implied by `workspaceId`:
// present → edit (PUT), absent → create (POST).
//
// Create-mode also gates on DPA acceptance: a workspace owner becomes
// a controller for personal data their members place inside the
// workspace, and we become their processor, the DPA is the contract
// that governs that. When the current user hasn't accepted the
// current DPA version yet, we surface an inline checkbox + link to
// the DPA inside this same modal. Submit then fires two calls in
// order: POST /api/user/dpa-accept, then POST /api/workspaces. The
// server-side guard in /api/workspaces returns 409 if DPA is missing,
// so a determined client can't bypass via direct curl.
import { useCreateWorkspace, useUpdateWorkspace } from '~/queries/workspaces'

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

const { t, locale } = useI18n()
const toast = useToast()
const { extractError } = useErrorHandler()
const { status: accountStatus, refresh: refreshAccountStatus } = useAccountStatus()

const name = ref('')
const description = ref('')
const saving = ref(false)
// Both refresh the workspace list; creating also the owned-workspace cap.
const createWorkspace = useCreateWorkspace()
const updateWorkspace = useUpdateWorkspace()
const dpaChecked = ref(false)

const isEdit = computed(() => !!props.workspaceId)
const dpaRequired = computed(() =>
  !isEdit.value && accountStatus.value?.policy?.dpa?.acceptanceRequired === true
)
const dpaCurrentVersion = computed(() =>
  accountStatus.value?.policy?.dpa?.currentVersion ?? 0
)
const canSubmit = computed(() => {
  if (saving.value) return false
  if (name.value.trim().length === 0) return false
  if (dpaRequired.value && !dpaChecked.value) return false
  return true
})

watch(open, (v) => {
  if (v) {
    name.value = props.initialName ?? ''
    description.value = props.initialDescription ?? ''
    dpaChecked.value = false
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
    if (props.workspaceId) {
      await updateWorkspace.mutateAsync({ workspaceId: props.workspaceId, body: payload })
      emit('updated', payload)
    } else {
      // Record DPA acceptance FIRST if required. The workspace POST
      // would 409 otherwise. Using two calls (vs combining them in
      // one server endpoint) keeps each endpoint single-purpose
      // and the audit log records DPA acceptance distinctly from
      // workspace creation.
      if (dpaRequired.value) {
        await apiFetch('/api/user/dpa-accept', {
          method: 'post',
          body: {
            dpaVersion: dpaCurrentVersion.value,
            locale: locale.value
          }
        })
        // Refresh status so the Profile page's Legal section
        // updates next time the user opens it.
        void refreshAccountStatus()
      }
      const res = await createWorkspace.mutateAsync(payload)
      emit('created', res.workspaceId)
    }
    open.value = false
  } catch (e) {
    const err = extractError(e)
    if (err.code === 'dpa/version-stale' || err.code === 'workspace/dpa-required') {
      // DPA bumped between modal-open and submit, refresh status
      // and reset the checkbox so the user re-confirms.
      await refreshAccountStatus()
      dpaChecked.value = false
      toast.add({
        title: t('workspace.dpa.staleTitle'),
        description: err.message,
        icon: 'i-lucide-refresh-cw',
        color: 'neutral'
      })
    } else {
      toast.add({
        title: isEdit.value ? t('workspace.saveFailed') : t('workspace.createFailed'),
        description: err.message,
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
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
    :content="initialFocus('workspace-form-name')"
  >
    <template #body>
      <div class="space-y-4">
        <div>
          <UFormField
            :label="t('workspace.nameLabel')"
            :ui="{ container: 'mt-2' }"
          >
            <UInput
              id="workspace-form-name"
              v-model="name"
              :placeholder="t('workspace.namePlaceholder')"
              size="md"
              class="w-full"
              :ui="{ base: 'w-full' }"
              data-testid="workspace-form-name"
              @keydown.enter="handleSubmit"
            />
          </UFormField>
        </div>
        <div>
          <UFormField
            :label="t('workspace.descriptionOptional')"
            :ui="{ container: 'mt-2' }"
          >
            <UTextarea
              id="workspace-form-description"
              v-model="description"
              :placeholder="t('workspace.descriptionPlaceholder')"
              :rows="3"
              class="w-full"
              :ui="{ base: 'w-full' }"
              data-testid="workspace-form-description"
            />
          </UFormField>
        </div>

        <!-- DPA acceptance gate. Surfaces only when the current
             user hasn't accepted the current DPA version. Workspaces
             are the only surface in markoto where DPA is contractually
             required: all other features are governed by the
             Privacy Policy + Terms alone. -->
        <div
          v-if="dpaRequired"
          class="border border-default rounded-lg p-3 bg-muted"
          data-testid="workspace-form-dpa-section"
        >
          <p class="text-xs text-muted mb-2 font-mono uppercase tracking-wider">
            {{ t('workspace.dpa.heading') }}
          </p>
          <p class="text-sm text-muted mb-3">
            {{ t('workspace.dpa.body') }}
          </p>
          <UCheckbox
            v-model="dpaChecked"
            data-testid="workspace-form-dpa-checkbox"
          >
            <template #label>
              <i18n-t
                keypath="legal.onboarding.acceptDocument"
                tag="span"
                scope="global"
              >
                <template #document>
                  <NuxtLink
                    to="/legal/dpa"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                  >
                    {{ t('legal.policyAcceptance.documentNames.dpa') }}
                  </NuxtLink>
                </template>
              </i18n-t>
              <span class="font-mono text-[11px] text-muted ml-1">
                v{{ dpaCurrentVersion }}
              </span>
            </template>
          </UCheckbox>
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
          color="neutral"
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
