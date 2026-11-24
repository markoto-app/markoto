<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { IMAGE_PROMPT_MAX_LENGTH, IMAGE_SIZE_NAMES, type ImageSize } from '~~/shared/ai/imageGeneration'
import { dollarsToPoints } from '~~/shared/billing/aiPoints'
import { useInvalidateAiCredits } from '~/queries/ai'
import type { ExtractedError } from '~/composables/platform/useErrorHandler'
import { insertBlockAtCursor } from '~/utils/editor/editorCommands'

// Insert → "Generate image with AI": what the AI's `generate_image` does,
// by hand. A description and a format; the cost in AI Points shows before
// generating (or that the user's own image key pays). The server runs the
// agent's code path (`POST /api/docs/:docId/images/generate`) and the
// returned Markdown goes in at the cursor as its own paragraph. Opened
// through `useGenerateImageDialog` (a plan without image generation gets
// the lock explanation instead); a missing provider shows the way to
// Settings → AI provider here.

const props = defineProps<{
  docId: string
  view: EditorView | null
  readOnly: boolean
}>()

const { open } = useGenerateImageDialog()

const { t, locale } = useI18n()
const { extractError } = useErrorHandler()
const { availability } = useAiAvailability()
const workspaceContext = useAiWorkspaceContext()
const invalidateCredits = useInvalidateAiCredits(() => workspaceContext.value)

const prompt = ref('')
const size = ref<ImageSize>('square')
const generating = ref(false)
const failure = ref<ExtractedError | null>(null)

watch(open, (v) => {
  if (v) failure.value = null
})

const image = computed(() => availability.value?.image ?? null)
/** Known and missing: the dialog shows the way to the settings instead of the form. */
const providerMissing = computed(() => image.value !== null && !image.value.available)

const sizeItems = computed(() => IMAGE_SIZE_NAMES.map(name => ({ label: t(`aiImage.size.${name}`), value: name })))

const costLine = computed(() => {
  const img = image.value
  if (!img) return null
  if (!img.platformBilled) return t('aiImage.ownKey')
  if (typeof img.pricePerImageUsd !== 'number') return t('aiImage.costUnknown')
  return t('aiImage.cost', { points: dollarsToPoints(img.pricePerImageUsd).toLocaleString(locale.value) })
})

const canGenerate = computed(() => !generating.value && prompt.value.trim().length > 0)

async function generate() {
  if (!canGenerate.value) return
  generating.value = true
  failure.value = null
  try {
    const res = await apiFetch('/api/docs/:docId/images/generate', {
      method: 'post',
      path: { docId: props.docId },
      body: { prompt: prompt.value.trim(), size: size.value }
    })
    if (props.view && !props.readOnly) insertBlockAtCursor(props.view, res.markdown)
    prompt.value = ''
    open.value = false
  } catch (e) {
    failure.value = extractError(e)
  } finally {
    generating.value = false
    void invalidateCredits()
  }
}

const recoveryAction = computed(() => {
  const r = failure.value?.recovery
  if (r?.kind !== 'link' || !r.href || !r.labelKey) return null
  const href = r.href
  const onClick = () => {
    void navigateTo(href)
  }
  return { label: t(r.labelKey), color: 'neutral' as const, variant: 'outline' as const, onClick }
})

// Out of AI Points (own or the free pool): the purchase that gives more,
// when there is one here, and always the user's own key.
const { budgetActions } = useAiWayForward()
const failureActions = computed(() => {
  const code = failure.value?.code
  if (code === 'ai/budget-exhausted' || code === 'ai/free-allowance-exhausted') {
    return budgetActions().map(a => ({ ...a, variant: 'outline' as const }))
  }
  return recoveryAction.value ? [recoveryAction.value] : undefined
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('aiImage.title')"
    :dismissible="!generating"
    :content="initialFocus('generate-image-prompt')"
  >
    <template #content>
      <div
        class="p-6 space-y-4"
        data-testid="generate-image-modal"
      >
        <div class="flex items-start gap-3">
          <div class="size-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <UIcon
              name="i-lucide-image-plus"
              class="size-5 text-primary"
            />
          </div>
          <h2 class="text-lg font-semibold pt-1.5">
            {{ t('aiImage.title') }}
          </h2>
        </div>

        <div
          v-if="providerMissing"
          class="space-y-3"
          data-testid="generate-image-missing"
        >
          <p class="text-sm text-muted">
            {{ t('aiProvider.missing.image') }}
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="open = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              color="neutral"
              icon="i-lucide-key-round"
              :to="AI_SETTINGS_ROUTE"
            >
              {{ t('aiProvider.missing.cta') }}
            </UButton>
          </div>
        </div>

        <template v-else>
          <UFormField :label="t('aiImage.promptLabel')">
            <UTextarea
              id="generate-image-prompt"
              v-model="prompt"
              :placeholder="t('aiImage.promptPlaceholder')"
              :maxlength="IMAGE_PROMPT_MAX_LENGTH"
              :rows="4"
              autoresize
              class="w-full"
              :disabled="generating"
              data-testid="generate-image-prompt"
              @keydown.meta.enter="generate"
              @keydown.ctrl.enter="generate"
            />
          </UFormField>
          <UFormField :label="t('aiImage.sizeLabel')">
            <UTabs
              v-model="size"
              :items="sizeItems"
              :content="false"
              color="neutral"
              size="sm"
              :disabled="generating"
              data-testid="generate-image-size"
            />
          </UFormField>

          <UAlert
            v-if="failure"
            color="error"
            variant="subtle"
            icon="i-lucide-alert-circle"
            :title="t('aiImage.failed')"
            :description="failure.message"
            :actions="failureActions"
            data-testid="generate-image-error"
          />

          <div class="flex items-center justify-between gap-3 flex-wrap">
            <p
              class="text-xs text-muted"
              data-testid="generate-image-cost"
            >
              {{ costLine ?? '' }}
            </p>
            <div class="flex gap-2 ml-auto">
              <UButton
                variant="ghost"
                :disabled="generating"
                @click="open = false"
              >
                {{ t('common.cancel') }}
              </UButton>
              <UButton
                color="neutral"
                icon="i-lucide-sparkles"
                :loading="generating"
                :disabled="!canGenerate"
                data-testid="generate-image-submit"
                @click="generate"
              >
                {{ generating ? t('aiImage.generating') : t('aiImage.generate') }}
              </UButton>
            </div>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
