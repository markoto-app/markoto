<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import type { ApiResponse } from '~/utils/api/client'
import {
  DESIGN_IMPORT_ERROR_CODES,
  DESIGN_IMPORT_MAX_BYTES,
  DESIGN_IMPORT_MIME,
  isDesignImportExt
} from '~~/shared/config/designImport'
import {
  SAVED_THEME_DESCRIPTION_MAX,
  SAVED_THEME_NAME_MAX,
  checkSavedThemeDescription,
  checkSavedThemeName
} from '~~/shared/config/savedThemes'

/**
 * "Create a design from a document" (theme panel). The user picks a PDF or
 * Word file in their organisation's design; the server reads it in the
 * sandboxed markitdown container, the user's own AI provider proposes a
 * theme, and a sample is rendered in it and compared (server/utils/
 * designImport/). The dialog shows progress, then the result next to the
 * original's first page, and lets the user save it as one of their
 * designs or apply it to the open document.
 */
const props = defineProps<{
  /** False in a read-only document: no "Apply" button. */
  canApply: boolean
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  saved: [name: string]
  apply: [theme: DocTheme]
}>()

const { t } = useI18n()
const toast = useToast()
const { extractError } = useErrorHandler()
const { availability } = useAiAvailability()
const aiSettingsRoute = AI_SETTINGS_ROUTE

type Step = 'pick' | 'working' | 'result' | 'error'
type Phase = 'uploading' | 'reading' | 'designing' | 'rendering'

type JobView = ApiResponse<'/api/themes/from-document/jobs/:jobId', 'get'>
type JobResult = NonNullable<JobView['result']>

const step = ref<Step>('pick')
const phase = ref<Phase>('uploading')
const round = ref(0)
const maxRounds = ref(3)
const errorKey = ref('internal')
const result = shallowRef<JobResult | null>(null)
const format = ref<'pdf' | 'docx'>('pdf')
const fileName = ref('')
const name = ref('')
const description = ref('')
const saving = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
/** Page shown side by side (original page n next to our page n). */
const pageIndex = ref(0)
const pageCount = computed(() => Math.max(result.value?.original.length ?? 0, result.value?.preview.length ?? 0))
let pollTimer: ReturnType<typeof setTimeout> | null = null
let runToken = 0

/** Known up front: the provider can't read images (null = not loaded yet → let the server decide). */
const noVision = computed(() => {
  const a = availability.value
  return a !== null && (!a.chat.available || !a.chat.supportsVision)
})

const showSettingsLink = computed(() => errorKey.value === 'no-vision' || errorKey.value === 'provider-missing' || errorKey.value === 'provider-error' || errorKey.value === 'budget')

function reset() {
  stopPolling()
  runToken++
  step.value = 'pick'
  phase.value = 'uploading'
  round.value = 0
  result.value = null
  fileName.value = ''
  saving.value = false
}

watch(open, (v) => {
  if (v) reset()
  else stopPolling()
})
onBeforeUnmount(stopPolling)

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

/** Stable i18n suffix for a failed request. */
function errorKeyFrom(e: unknown): string {
  const { code, statusCode } = extractError(e)
  if (code === 'design-import/no-vision') return 'no-vision'
  if (code === 'ai/provider-missing') return 'provider-missing'
  if (code === 'design-import/too-large') return 'too-large'
  if (code === 'design-import/unsupported-format') return 'format'
  if (code === 'design-import/rate-limited') return 'rate-limited'
  if (code === 'design-import/busy') return 'busy'
  if (code === 'design-import/content-mismatch') return 'unreadable'
  if (code === 'ai/free-allowance-exhausted' || code === 'ai/budget-exhausted') return 'budget'
  if (statusCode === 404) return 'upload-failed'
  return 'internal'
}

function fail(key: string) {
  stopPolling()
  errorKey.value = key
  step.value = 'error'
}

function choose() {
  fileInput.value?.click()
}

async function onFile(event: Event) {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!isDesignImportExt(ext)) return fail('format')
  if (file.size > DESIGN_IMPORT_MAX_BYTES) return fail('too-large')

  const token = ++runToken
  fileName.value = file.name
  format.value = ext
  step.value = 'working'
  phase.value = 'uploading'
  round.value = 0
  try {
    const ticket = await apiFetch('/api/themes/from-document/upload-request', {
      method: 'post',
      body: { filename: file.name, size: file.size }
    })
    const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': ticket.mimeType || DESIGN_IMPORT_MIME[ext] }, body: file })
    if (!put.ok) return fail('upload-failed')
    const { jobId } = await apiFetch('/api/themes/from-document/start', {
      method: 'post',
      body: { uploadId: ticket.uploadId }
    })
    if (token !== runToken) return
    phase.value = 'reading'
    poll(jobId, token)
  } catch (e) {
    if (token === runToken) fail(errorKeyFrom(e))
  }
}

function poll(jobId: string, token: number) {
  pollTimer = setTimeout(async () => {
    if (token !== runToken || !open.value) return
    try {
      const job = await apiFetch('/api/themes/from-document/jobs/:jobId', { path: { jobId } })
      if (token !== runToken) return
      maxRounds.value = job.maxRounds
      round.value = job.round
      if (job.phase === 'done' && job.result) {
        result.value = job.result
        pageIndex.value = 0
        name.value = job.result.name.slice(0, SAVED_THEME_NAME_MAX)
        description.value = job.result.description.slice(0, SAVED_THEME_DESCRIPTION_MAX)
        step.value = 'result'
        return
      }
      if (job.phase === 'error') {
        const code = job.error?.code ?? 'internal'
        return fail((DESIGN_IMPORT_ERROR_CODES as readonly string[]).includes(code) ? code : 'internal')
      }
      phase.value = job.phase === 'done' ? 'rendering' : job.phase
      poll(jobId, token)
    } catch (e) {
      fail(errorKeyFrom(e))
    }
  }, 1500)
}

const phaseLabel = computed(() => t(`designImport.phase.${phase.value}`))

// The AI's own line while it works (italic serif + pulsing seal, the
// product's one "AI is thinking" voice) and how long it has been at it:
// a run takes a few minutes, and a bare progress bar looks stuck.
const thinkingLine = computed(() => {
  if (phase.value === 'designing' && round.value > 1) {
    return t('designImport.thinking.comparing', { round: round.value, max: maxRounds.value })
  }
  return t(`designImport.thinking.${phase.value}`)
})
const elapsedSeconds = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
watch(step, (now) => {
  if (elapsedTimer) clearInterval(elapsedTimer)
  elapsedTimer = null
  if (now !== 'working') return
  elapsedSeconds.value = 0
  elapsedTimer = setInterval(() => {
    elapsedSeconds.value++
  }, 1000)
})
onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer)
})
const elapsedLabel = computed(() => {
  const m = Math.floor(elapsedSeconds.value / 60)
  const sec = String(elapsedSeconds.value % 60).padStart(2, '0')
  return `${m}:${sec}`
})
const progressValue = computed(() => {
  const order: Phase[] = ['uploading', 'reading', 'designing', 'rendering']
  const base = order.indexOf(phase.value)
  if (phase.value === 'uploading' || phase.value === 'reading') return 5 + base * 10
  return Math.min(95, 25 + (round.value / Math.max(1, maxRounds.value)) * 70)
})

const nameCheck = computed(() => checkSavedThemeName(name.value))
const descriptionCheck = computed(() => checkSavedThemeDescription(description.value))

async function save() {
  const r = result.value
  const n = nameCheck.value
  const d = descriptionCheck.value
  if (!r || !n.ok || !d.ok || saving.value) return
  saving.value = true
  try {
    await apiFetch('/api/themes', { method: 'post', body: { name: n.value, description: d.value, theme: r.theme } })
    emit('saved', n.value)
    open.value = false
  } catch (e) {
    toast.add({
      title: t('theme.saved.saveFailedTitle'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

function apply() {
  const r = result.value
  if (!r || !props.canApply) return
  emit('apply', structuredClone(toRaw(r.theme)))
  open.value = false
}

function png(base64: string): string {
  return `data:image/png;base64,${base64}`
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('designImport.title')"
    :description="t('designImport.intro')"
    :ui="{ content: step === 'result' ? 'sm:max-w-3xl' : 'sm:max-w-lg' }"
  >
    <template #content>
      <div
        class="p-6 space-y-5"
        data-testid="design-import-dialog"
      >
        <div>
          <h2 class="font-serif text-2xl font-normal tracking-tight">
            {{ t('designImport.title') }}
          </h2>
          <p
            v-if="step !== 'result'"
            class="text-sm text-muted mt-1.5 leading-relaxed"
          >
            {{ t('designImport.intro') }}
          </p>
        </div>

        <template v-if="step === 'pick'">
          <div
            v-if="noVision"
            class="rounded-md border border-default bg-elevated p-4 text-sm space-y-3"
            data-testid="design-import-no-vision"
          >
            <p>{{ t('designImport.errors.no-vision') }}</p>
            <UButton
              :to="aiSettingsRoute"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-settings"
            >
              {{ t('designImport.openAiSettings') }}
            </UButton>
          </div>
          <template v-else>
            <input
              ref="fileInput"
              type="file"
              class="hidden"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              data-testid="design-import-file"
              @change="onFile"
            >
            <button
              type="button"
              class="w-full rounded-md border border-dashed border-default bg-default hover:bg-elevated transition-colors p-6 flex flex-col items-center gap-2 text-center focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              data-testid="design-import-choose"
              @click="choose"
            >
              <UIcon
                name="i-lucide-file-up"
                class="size-6 text-muted"
              />
              <span class="text-sm font-medium">{{ t('designImport.chooseFile') }}</span>
              <span class="text-xs text-muted">{{ t('designImport.fileHint') }}</span>
            </button>
            <p class="font-mono text-[10.5px] tracking-[0.04em] text-muted">
              {{ t('designImport.costNote') }}
            </p>
          </template>
        </template>

        <div
          v-else-if="step === 'working'"
          class="space-y-3"
          data-testid="design-import-progress"
        >
          <p class="text-sm truncate">
            {{ fileName }}
          </p>
          <div
            class="mk-design-import-thinking"
            role="status"
            aria-live="polite"
            data-testid="design-import-thinking"
          >
            <AiThinking :text="thinkingLine" />
          </div>
          <UProgress
            :model-value="progressValue"
            color="neutral"
            size="sm"
          />
          <p class="flex items-center justify-between gap-3 font-mono text-[10.5px] tracking-[0.04em] text-muted">
            <span>{{ phaseLabel }}<template v-if="phase === 'designing' && round > 0">
              · {{ t('designImport.roundOf', { round, max: maxRounds }) }}
            </template></span>
            <span
              class="tabular-nums"
              data-testid="design-import-elapsed"
            >{{ elapsedLabel }}</span>
          </p>
          <p class="text-xs text-muted leading-snug">
            {{ t('designImport.durationNote') }}
          </p>
        </div>

        <div
          v-else-if="step === 'error'"
          class="space-y-4"
          data-testid="design-import-error"
          :data-error="errorKey"
        >
          <p class="text-sm">
            {{ t(`designImport.errors.${errorKey}`) }}
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              v-if="showSettingsLink"
              :to="aiSettingsRoute"
              color="neutral"
              variant="ghost"
              icon="i-lucide-settings"
            >
              {{ t('designImport.openAiSettings') }}
            </UButton>
            <UButton
              color="neutral"
              data-testid="design-import-retry"
              @click="reset"
            >
              {{ t('designImport.tryAnother') }}
            </UButton>
          </div>
        </div>

        <form
          v-else-if="result"
          class="space-y-5"
          data-testid="design-import-result"
          novalidate
          @submit.prevent="save"
        >
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <figure class="space-y-2">
              <figcaption class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
                {{ t('designImport.original') }}
              </figcaption>
              <img
                v-if="result.original.length > 0"
                :src="png(result.original[Math.min(pageIndex, result.original.length - 1)] ?? '')"
                :alt="t('designImport.originalAlt')"
                class="w-full border border-default bg-white"
                data-testid="design-import-original"
              >
              <div
                v-else
                class="rounded-md border border-default bg-default p-4 space-y-3 text-sm"
                data-testid="design-import-docx-facts"
              >
                <p class="text-muted text-xs leading-relaxed">
                  {{ t('designImport.noPagePictures') }}
                </p>
                <div class="flex gap-1.5 flex-wrap">
                  <span
                    v-for="c in result.swatches"
                    :key="c"
                    class="size-5 rounded-sm border border-default"
                    :style="{ backgroundColor: c }"
                    :title="c"
                  />
                </div>
              </div>
            </figure>
            <figure class="space-y-2">
              <figcaption class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
                {{ t('designImport.ours') }}
              </figcaption>
              <img
                v-if="result.preview.length > 0"
                :src="png(result.preview[Math.min(pageIndex, result.preview.length - 1)] ?? '')"
                :alt="t('designImport.oursAlt')"
                class="w-full border border-default bg-white"
                data-testid="design-import-preview"
              >
              <p
                v-else
                class="text-xs text-muted"
              >
                {{ t('designImport.noPreview') }}
              </p>
            </figure>
          </div>

          <div
            v-if="pageCount > 1"
            class="flex items-center justify-center gap-1"
            data-testid="design-import-pages"
          >
            <UButton
              v-for="n in pageCount"
              :key="n"
              size="xs"
              color="neutral"
              :variant="pageIndex === n - 1 ? 'solid' : 'ghost'"
              :aria-label="t('designImport.pageAria', { n })"
              @click="pageIndex = n - 1"
            >
              {{ n }}
            </UButton>
          </div>

          <div
            v-if="result.fonts.length > 0"
            class="space-y-1"
          >
            <h3 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
              {{ t('designImport.fontsTitle') }}
            </h3>
            <ul
              class="text-xs text-muted space-y-0.5"
              data-testid="design-import-fonts"
            >
              <li
                v-for="f in result.fonts.slice(0, 6)"
                :key="`${f.from}-${f.to}`"
              >
                {{ f.exact ? f.to : t('designImport.fontSubstituted', { from: f.from, to: f.to }) }}
              </li>
            </ul>
          </div>

          <UFormField
            :label="t('theme.saved.nameLabel')"
            :error="nameCheck.ok ? undefined : t('theme.saved.nameRequired')"
            name="name"
            required
          >
            <UInput
              v-model="name"
              :maxlength="SAVED_THEME_NAME_MAX"
              class="w-full"
              data-testid="design-import-name"
            />
          </UFormField>
          <UFormField
            :label="t('theme.saved.descriptionLabel')"
            name="description"
          >
            <UTextarea
              v-model="description"
              :maxlength="SAVED_THEME_DESCRIPTION_MAX"
              :rows="2"
              autoresize
              class="w-full"
              data-testid="design-import-description"
            />
          </UFormField>

          <div class="flex gap-2 justify-end flex-wrap">
            <UButton
              color="neutral"
              variant="ghost"
              data-testid="design-import-retry"
              @click="reset"
            >
              {{ t('designImport.tryAnother') }}
            </UButton>
            <UButton
              v-if="canApply"
              color="neutral"
              variant="outline"
              data-testid="design-import-apply"
              @click="apply"
            >
              {{ t('designImport.apply') }}
            </UButton>
            <UButton
              type="submit"
              color="neutral"
              :loading="saving"
              :disabled="!nameCheck.ok || !descriptionCheck.ok"
              data-testid="design-import-save"
            >
              {{ t('designImport.save') }}
            </UButton>
          </div>
        </form>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/* The seal pulses while the AI works (same breathing as the prompt bar's
   active state); still under reduced motion. */
.mk-design-import-thinking :deep(.mk-ai-thinking__seal) {
  animation: mk-design-import-seal 1.8s ease-in-out infinite;
}
@keyframes mk-design-import-seal {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-shu-500) 45%, transparent); transform: scale(1); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--color-shu-500) 0%, transparent); transform: scale(1.25); }
}
@media (prefers-reduced-motion: reduce) {
  .mk-design-import-thinking :deep(.mk-ai-thinking__seal) { animation: none; }
}
</style>
