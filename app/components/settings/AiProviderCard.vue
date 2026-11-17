<script setup lang="ts">
// One capability (chat / image / transcription) on the "AI provider"
// settings page: shows where the capability currently comes from (own
// key / instance default / nothing) and lets the user add, change,
// verify or remove their own OpenAI-compatible provider.
//
// The API key is write-only from the UI's point of view: the server
// never returns it (only the last four characters). Leaving the key
// field empty on "change" keeps the stored key, but only while the base
// URL stays the same (the server enforces this).

import {
  codeKey,
  type AiCapability,
  type AiCapabilityStatus,
  type AiProviderConfigView,
  type ProviderPreset
} from '~~/shared/ai/providers'
import { apiErrorData } from '~/utils/api/errors'
import { trimTrailing } from '~/utils/markdown/trimTrailing'
import { useRemoveAiProvider, useSaveAiProvider, useVerifyAiProvider } from '~/queries/ai'

const props = defineProps<{
  capability: AiCapability
  config: AiProviderConfigView | null
  status: AiCapabilityStatus & { liveDictation?: boolean }
  presets: ProviderPreset[]
}>()

const { t, locale } = useI18n()
const toast = useToast()
const { handleReauthRequired, extractError } = useErrorHandler()

const CUSTOM = 'custom'
const editing = ref(false)
const presetId = ref<string>(CUSTOM)
const baseUrl = ref('')
const model = ref('')
// Chat only: the worker model on the same endpoint and key.
const fastModel = ref('')
const apiKey = ref('')
const supportsVision = ref(false)
// Each mutation re-reads the providers and the AI availability it changes.
const saveProvider = useSaveAiProvider()
const verifyProvider = useVerifyAiProvider()
const removeProvider = useRemoveAiProvider()
const saving = computed(() => saveProvider.isLoading.value)
const verifying = computed(() => verifyProvider.isLoading.value)
const removing = computed(() => removeProvider.isLoading.value)
const lastMessage = ref<{ tone: 'success' | 'warning' | 'error', text: string } | null>(null)

const presetItems = computed(() => [
  ...props.presets.map(p => ({ label: p.label, value: p.id })),
  { label: t('aiProvider.form.custom'), value: CUSTOM }
])

const selectedPreset = computed(() => props.presets.find(p => p.id === presetId.value) ?? null)
const modelSuggestions = computed(() => selectedPreset.value?.models[props.capability] ?? [])

watch(presetId, (id) => {
  const preset = props.presets.find(p => p.id === id)
  if (!preset) return
  baseUrl.value = preset.baseUrl
  const suggestion = preset.models[props.capability]?.[0]
  if (suggestion && !model.value) model.value = suggestion
})

function presetFor(url: string): string {
  const trimmed = trimTrailing(url.trim(), '/')
  return props.presets.find(p => p.baseUrl === trimmed)?.id ?? CUSTOM
}

// Typing a URL that isn't a preset's switches the picker to "Other", so
// the model suggestions never belong to a different provider.
watch(baseUrl, (url) => {
  const id = presetFor(url)
  if (id !== presetId.value) presetId.value = id
})

function startEdit(): void {
  lastMessage.value = null
  if (props.config) {
    baseUrl.value = props.config.baseUrl
    model.value = props.config.model
    fastModel.value = props.config.fastModel ?? ''
    supportsVision.value = props.config.supportsVision
    presetId.value = presetFor(props.config.baseUrl)
  } else {
    const first = props.presets.find(p => p.models[props.capability]?.length) ?? props.presets[0]
    presetId.value = first?.id ?? CUSTOM
    baseUrl.value = first?.baseUrl ?? ''
    model.value = first?.models[props.capability]?.[0] ?? ''
    fastModel.value = ''
    supportsVision.value = props.capability === 'chat'
  }
  apiKey.value = ''
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  apiKey.value = ''
}

function sourceLabel(): string {
  if (props.status.source === 'user') return t('aiProvider.status.own')
  if (props.status.source === 'instance') return t('aiProvider.status.instance')
  // The platform offers it, but not on this plan.
  if (props.status.locked === 'plan') return t('aiProvider.status.locked')
  return t('aiProvider.status.none')
}

function fmtDate(iso: string | null): string {
  if (!iso) return t('aiProvider.status.never')
  try {
    return t('aiProvider.status.lastVerified', {
      date: new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
    })
  } catch {
    return t('aiProvider.status.lastVerified', { date: iso })
  }
}

/**
 * The refusal in the reader's language (the per-reason text or the code's
 * text, app/utils/api/errors.ts), followed by the server's own (English)
 * detail when it says something else.
 */
function errorText(e: unknown, fallbackKey: string): string {
  const { code, message } = extractError(e)
  const raw = apiErrorData(e)?.message
  const detail = typeof raw === 'string' ? raw : ''
  if (code !== null) return detail && detail !== message ? `${message}: ${detail}` : message
  return detail || t(fallbackKey)
}

async function onSave(): Promise<void> {
  if (saving.value) return
  lastMessage.value = null
  try {
    const resp = await saveProvider.mutateAsync({
      capability: props.capability,
      body: {
        baseUrl: baseUrl.value.trim(),
        model: model.value.trim(),
        fastModel: props.capability === 'chat' ? (fastModel.value.trim() || null) : undefined,
        apiKey: apiKey.value.trim() || undefined,
        supportsVision: props.capability === 'chat' ? supportsVision.value : undefined
      }
    })
    editing.value = false
    apiKey.value = ''
    const warn = resp.verify.code !== 'ok'
    lastMessage.value = { tone: warn ? 'warning' : 'success', text: t(`aiProvider.verify.${codeKey(resp.verify.code)}`) }
    toast.add({ title: t(warn ? 'aiProvider.toast.savedWithWarning' : 'aiProvider.toast.saved'), color: warn ? 'warning' : 'success', icon: 'i-lucide-check' })
  } catch (e) {
    if (handleReauthRequired(e)) return
    lastMessage.value = { tone: 'error', text: errorText(e, 'aiProvider.toast.saveFailed') }
  }
}

async function onVerify(): Promise<void> {
  if (verifying.value) return
  lastMessage.value = null
  try {
    const resp = await verifyProvider.mutateAsync(props.capability)
    const text = t(`aiProvider.verify.${codeKey(resp.code)}`)
    lastMessage.value = { tone: resp.ok ? (resp.code === 'ok' ? 'success' : 'warning') : 'error', text: resp.ok ? text : `${text}: ${resp.message}` }
  } catch (e) {
    lastMessage.value = { tone: 'error', text: errorText(e, 'aiProvider.toast.verifyFailed') }
  }
}

async function onRemove(): Promise<void> {
  if (removing.value) return
  lastMessage.value = null
  try {
    await removeProvider.mutateAsync(props.capability)
    toast.add({ title: t('aiProvider.toast.removed'), color: 'neutral', icon: 'i-lucide-check' })
  } catch (e) {
    if (handleReauthRequired(e)) return
    lastMessage.value = { tone: 'error', text: errorText(e, 'aiProvider.toast.saveFailed') }
  }
}

const messageClass = computed(() => {
  const tone = lastMessage.value?.tone
  if (tone === 'success') return 'text-green-700 dark:text-green-400'
  if (tone === 'error') return 'text-rose-700 dark:text-rose-400'
  return 'text-muted'
})
</script>

<template>
  <section
    class="border border-default rounded-lg px-4 py-4 bg-default"
    :data-testid="`ai-provider-card-${capability}`"
  >
    <div class="flex items-start justify-between gap-3 mb-2">
      <div class="min-w-0">
        <h2 class="font-serif text-lg font-normal tracking-tight">
          {{ t(`aiProvider.capability.${capability}.title`) }}
        </h2>
        <p class="text-sm text-muted">
          {{ t(`aiProvider.capability.${capability}.description`) }}
        </p>
      </div>
      <UBadge
        variant="subtle"
        color="neutral"
        size="sm"
        class="shrink-0"
        :data-testid="`ai-provider-source-${capability}`"
      >
        {{ sourceLabel() }}
      </UBadge>
    </div>

    <dl
      v-if="config && !editing"
      class="text-sm divide-y divide-default border border-default rounded-md my-3"
    >
      <div class="flex flex-col sm:flex-row sm:justify-between gap-1 px-3 py-2">
        <dt class="text-muted">
          {{ t('aiProvider.form.preset') }}
        </dt>
        <dd
          class="font-mono break-all sm:text-right"
          :data-testid="`ai-provider-host-${capability}`"
        >
          {{ config.host }}
        </dd>
      </div>
      <div class="flex flex-col sm:flex-row sm:justify-between gap-1 px-3 py-2">
        <dt class="text-muted">
          {{ t('aiProvider.form.model') }}
        </dt>
        <dd class="font-mono break-all sm:text-right">
          {{ config.model }}
        </dd>
      </div>
      <div
        v-if="config.fastModel"
        class="flex flex-col sm:flex-row sm:justify-between gap-1 px-3 py-2"
      >
        <dt class="text-muted">
          {{ t('aiProvider.form.fastModel') }}
        </dt>
        <dd
          class="font-mono break-all sm:text-right"
          :data-testid="`ai-provider-fast-model-${capability}`"
        >
          {{ config.fastModel }}
        </dd>
      </div>
      <div class="flex flex-col sm:flex-row sm:justify-between gap-1 px-3 py-2">
        <dt class="text-muted">
          {{ t('aiProvider.form.apiKey') }}
        </dt>
        <dd
          class="font-mono sm:text-right"
          :data-testid="`ai-provider-key-${capability}`"
        >
          {{ t('aiProvider.status.keyEnding', { last4: config.apiKeyLast4 }) }}
        </dd>
      </div>
      <div class="px-3 py-2 font-mono text-[11px] text-muted">
        {{ fmtDate(config.lastVerifiedAt) }}
      </div>
    </dl>

    <p
      v-if="config && !editing && capability === 'chat' && config.supportsTools === false"
      class="text-sm text-muted mb-3"
    >
      {{ t('aiProvider.status.noToolSupport') }}
    </p>
    <p
      v-if="capability === 'transcription' && status.liveDictation"
      class="text-sm text-muted mb-3"
    >
      {{ t('aiProvider.status.liveDictation') }}
    </p>

    <form
      v-if="editing"
      class="space-y-3 my-3"
      @submit.prevent="onSave"
    >
      <UFormField :label="t('aiProvider.form.preset')">
        <USelect
          v-model="presetId"
          :items="presetItems"
          class="w-full"
          :data-testid="`ai-provider-preset-${capability}`"
        />
      </UFormField>
      <UFormField
        :label="t('aiProvider.form.baseUrl')"
        :help="t('aiProvider.form.baseUrlHint')"
      >
        <UInput
          v-model="baseUrl"
          type="url"
          class="w-full font-mono"
          autocomplete="off"
          :data-testid="`ai-provider-base-url-${capability}`"
        />
      </UFormField>
      <UFormField :label="t('aiProvider.form.model')">
        <UInput
          v-model="model"
          class="w-full font-mono"
          autocomplete="off"
          :placeholder="modelSuggestions[0] ?? t('aiProvider.form.modelPlaceholder')"
          :data-testid="`ai-provider-model-${capability}`"
        />
      </UFormField>
      <p
        v-if="modelSuggestions.length > 1"
        class="text-xs text-muted -mt-2"
      >
        {{ t('aiProvider.form.suggestions', { list: modelSuggestions.join(', ') }) }}
      </p>
      <UFormField
        v-if="capability === 'chat'"
        :label="t('aiProvider.form.fastModel')"
        :help="t('aiProvider.form.fastModelHint')"
      >
        <UInput
          v-model="fastModel"
          class="w-full font-mono"
          autocomplete="off"
          :placeholder="t('aiProvider.form.modelPlaceholder')"
          data-testid="ai-provider-fast-model-input"
        />
      </UFormField>
      <UFormField
        :label="t('aiProvider.form.apiKey')"
        :help="config ? t('aiProvider.form.apiKeyKeep') : undefined"
      >
        <UInput
          v-model="apiKey"
          type="password"
          class="w-full font-mono"
          autocomplete="off"
          :placeholder="config ? '••••' + config.apiKeyLast4 : ''"
          :data-testid="`ai-provider-api-key-${capability}`"
        />
      </UFormField>
      <UCheckbox
        v-if="capability === 'chat'"
        v-model="supportsVision"
        :label="t('aiProvider.form.vision')"
      />
      <div class="flex flex-wrap gap-2 pt-1">
        <UButton
          type="submit"
          color="neutral"
          :loading="saving"
          :disabled="!baseUrl.trim() || !model.trim()"
          :data-testid="`ai-provider-save-${capability}`"
        >
          {{ t('aiProvider.form.save') }}
        </UButton>
        <UButton
          color="neutral"
          variant="ghost"
          @click="cancelEdit"
        >
          {{ t('aiProvider.form.cancel') }}
        </UButton>
      </div>
    </form>

    <p
      v-if="lastMessage"
      class="text-sm my-2"
      :class="messageClass"
      role="status"
      :data-testid="`ai-provider-message-${capability}`"
    >
      {{ lastMessage.text }}
    </p>

    <div
      v-if="!editing"
      class="flex flex-wrap gap-2 mt-3"
    >
      <UButton
        color="neutral"
        :variant="config ? 'outline' : 'solid'"
        size="sm"
        :icon="config ? 'i-lucide-pencil' : 'i-lucide-plus'"
        :data-testid="`ai-provider-edit-${capability}`"
        @click="startEdit"
      >
        {{ config ? t('aiProvider.form.edit') : t('aiProvider.form.add') }}
      </UButton>
      <UButton
        v-if="config"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-refresh-cw"
        :loading="verifying"
        :data-testid="`ai-provider-verify-${capability}`"
        @click="onVerify"
      >
        {{ t('aiProvider.form.verify') }}
      </UButton>
      <UButton
        v-if="config"
        color="error"
        variant="ghost"
        size="sm"
        icon="i-lucide-trash-2"
        :loading="removing"
        :data-testid="`ai-provider-remove-${capability}`"
        @click="onRemove"
      >
        {{ t('aiProvider.form.remove') }}
      </UButton>
    </div>
  </section>
</template>
