<script setup lang="ts">
import type { ApiRequest, ApiResponse } from '~/utils/api/client'
// Suggestion mode of the document, for the owner and workspace admins:
// require suggestions instead of direct edits (everyone but the owner and
// the exempt workspace roles), and let signed-in viewers suggest.
// Server: `server/api/docs/[docId]/suggestion-settings/`.

type Settings = ApiResponse<'/api/docs/:docId/suggestion-settings', 'get'>
type SettingsPatch = NonNullable<ApiRequest<'/api/docs/:docId/suggestion-settings', 'put'>['body']>

const props = defineProps<{
  docId: string
  /** Workspace document: the exempt roles apply (standalone documents have only the owner). */
  inWorkspace: boolean
}>()
const { t } = useI18n()
const { showError } = useErrorHandler()

const settings = ref<Settings | null>(null)
const busy = ref(false)

onMounted(async () => {
  try {
    settings.value = await apiFetch('/api/docs/:docId/suggestion-settings', { path: { docId: props.docId } })
  } catch {
    settings.value = null
  }
})

async function save(patch: SettingsPatch): Promise<void> {
  busy.value = true
  try {
    settings.value = await apiFetch('/api/docs/:docId/suggestion-settings', { method: 'put', path: { docId: props.docId }, body: patch })
  } catch (e) {
    showError('suggestions.settings.saveFailed', e)
  } finally {
    busy.value = false
  }
}

function toggleExempt(role: 'admin' | 'editor', on: boolean): void {
  const current = new Set(settings.value?.exemptRoles ?? [])
  if (on) current.add(role)
  else current.delete(role)
  void save({ exemptRoles: [...current] })
}
</script>

<template>
  <div
    v-if="settings"
    class="space-y-3"
    data-testid="suggestion-settings"
  >
    <p class="block text-sm font-medium">
      {{ t('suggestions.settings.title') }}
    </p>
    <USwitch
      :model-value="settings.required"
      :disabled="busy"
      :label="t('suggestions.settings.required')"
      :description="t('suggestions.settings.requiredHelp')"
      data-testid="suggestion-settings-required"
      @update:model-value="(v) => save({ required: v })"
    />
    <div
      v-if="settings.required && inWorkspace"
      class="pl-11 space-y-2"
    >
      <p class="text-xs text-muted">
        {{ t('suggestions.settings.exemptTitle') }}
      </p>
      <UCheckbox
        :model-value="settings.exemptRoles.includes('admin')"
        :disabled="busy"
        :label="t('suggestions.settings.exemptAdmins')"
        data-testid="suggestion-settings-exempt-admin"
        @update:model-value="(v) => toggleExempt('admin', v === true)"
      />
      <UCheckbox
        :model-value="settings.exemptRoles.includes('editor')"
        :disabled="busy"
        :label="t('suggestions.settings.exemptEditors')"
        data-testid="suggestion-settings-exempt-editor"
        @update:model-value="(v) => toggleExempt('editor', v === true)"
      />
    </div>
    <USwitch
      :model-value="settings.viewersMaySuggest"
      :disabled="busy"
      :label="t('suggestions.settings.viewers')"
      :description="t('suggestions.settings.viewersHelp')"
      data-testid="suggestion-settings-viewers"
      @update:model-value="(v) => save({ viewersMaySuggest: v })"
    />
  </div>
</template>
