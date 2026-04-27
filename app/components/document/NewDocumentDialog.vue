<script setup lang="ts">
import { AUDIENCE_KINDS, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_PRESETS, LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { TEMPLATES } from '~~/shared/templates'

// Same trick as ThemeEditorPanel — pull every picker font in a single
// Google Fonts request so each preset card can render its heading in
// its actual font face. Otherwise we'd see "Modern" / "Academic Paper"
// / etc. all in the system fallback and lose the visual signal.
if (import.meta.client) {
  const families = THEME_FONTS
    .map(f => `family=${f.name.replace(/ /g, '+')}:wght@400;500;600;700`)
    .join('&')
  useHead({
    link: [{
      key: 'newdoc-theme-font-preview',
      rel: 'stylesheet',
      href: `https://fonts.googleapis.com/css2?${families}&display=swap`
    }]
  })
}

/**
 * 5-question dialog shown when the user clicks "New document". The
 * answers seed the doc's first-class context (title/description/
 * audience/language) + theme + templateId at creation time, so the
 * editor opens with the right AI prompt context from turn 1.
 *
 * Two submit paths:
 *   - "Create" → POSTs the answers, navigates to /d/<id>
 *   - "Just give me a blank doc" → POSTs nothing extra (just the
 *     optional workspaceId), schema defaults take over
 *
 * Phase 4 ships only `templateId='blank'`; Phase 5 adds the structural
 * skeletons. The template field is hidden from the dialog until then
 * to avoid showing a single useless option.
 */

const props = defineProps<{
  open: boolean
  /** When set, the new doc files into this workspace. */
  workspaceId?: string | null
}>()

const emit = defineEmits<{
  'update:open': [boolean]
  /** Fired AFTER the doc is created so the parent can navigate. */
  'created': [docId: string]
}>()

const { t, locale } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

// Form state. Resets on open so reopening doesn't carry stale values.
const title = ref('')
const description = ref('')
const audience = ref<AudienceKind>('casual')
const themePreset = ref<string>('modern')
const templateId = ref<string>('blank')
// Language picker mirrors the Document tab: combobox + create-item.
interface LanguageItem { label: string, value: string, custom?: boolean }
const isPresetLanguage = (v: string) => (LANGUAGE_PRESETS as readonly string[]).includes(v)
function presetItemFor(code: string): LanguageItem {
  return { label: t(`languages.${code}`), value: code }
}
const presetItems = computed<LanguageItem[]>(() => LANGUAGE_PRESETS.map(presetItemFor))

// Default language = the user's UI locale if it's one of our presets,
// otherwise English. Keeps muscle memory: Spanish-UI users get Spanish
// docs without thinking, English-UI users keep English.
function defaultLanguageItem(): LanguageItem {
  const ui = String(locale.value)
  if (isPresetLanguage(ui)) return presetItemFor(ui)
  return presetItemFor('en')
}
const languageModel = ref<LanguageItem>(defaultLanguageItem())
const languageItems = computed<LanguageItem[]>(() => {
  if (languageModel.value.custom && languageModel.value.value.trim().length > 0) {
    return [languageModel.value, ...presetItems.value]
  }
  return presetItems.value
})

function onCreateLanguage(text: string): LanguageItem {
  const trimmed = text.trim().slice(0, LANGUAGE_MAX_LENGTH)
  return { label: trimmed, value: trimmed, custom: !isPresetLanguage(trimmed) }
}

watch(() => props.open, (next) => {
  if (!next) return
  title.value = ''
  description.value = ''
  audience.value = 'casual'
  themePreset.value = 'modern'
  templateId.value = 'blank'
  languageModel.value = defaultLanguageItem()
})

const audienceItems = computed(() => AUDIENCE_KINDS.map(kind => ({
  label: t(`audiences.${kind}.label`),
  description: t(`audiences.${kind}.description`),
  value: kind
})))

const submitting = ref(false)

async function submit(blank: boolean) {
  if (submitting.value) return
  submitting.value = true
  try {
    // `blank` collapses the dialog into the legacy zero-config flow:
    // schema defaults, no overrides. Keeps muscle memory for users
    // who don't want the form.
    const body: Record<string, unknown> = {}
    if (props.workspaceId) body.workspaceId = props.workspaceId
    if (!blank) {
      const trimmedTitle = title.value.trim()
      if (trimmedTitle) body.title = trimmedTitle
      const trimmedDesc = description.value.trim()
      if (trimmedDesc) body.description = trimmedDesc
      body.audience = audience.value
      const lang = (languageModel.value?.value ?? '').trim()
      if (lang) body.language = lang
      if (themePreset.value) body.themePreset = themePreset.value
      if (templateId.value) body.templateId = templateId.value
    }
    const { docId } = await $fetch<{ docId: string }>('/api/docs', {
      method: 'POST',
      body
    })
    emit('update:open', false)
    emit('created', docId)
  } catch (e) {
    showError('error.documentCreateFailed', e)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="t('newDoc.title')"
    :description="t('newDoc.subtitle')"
    :ui="{ content: 'max-w-xl' }"
    data-testid="new-doc-dialog"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <form
        class="space-y-5"
        @submit.prevent="submit(false)"
      >
        <!-- Title ─────────────────────────────────────────────── -->
        <div>
          <label
            for="newdoc-title"
            class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
          >
            {{ t('newDoc.titleLabel') }}
          </label>
          <UInput
            id="newdoc-title"
            v-model="title"
            :placeholder="t('newDoc.titlePlaceholder')"
            :maxlength="255"
            data-testid="newdoc-title-input"
            class="w-full"
            autofocus
          />
        </div>

        <!-- Description ───────────────────────────────────────── -->
        <div>
          <label
            for="newdoc-description"
            class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
          >
            {{ t('newDoc.descriptionLabel') }}
          </label>
          <p class="text-xs text-toned mb-2">
            {{ t('newDoc.descriptionHelp') }}
          </p>
          <UTextarea
            id="newdoc-description"
            v-model="description"
            :placeholder="t('newDoc.descriptionPlaceholder')"
            :rows="2"
            :maxrows="5"
            autoresize
            data-testid="newdoc-description-input"
            class="w-full"
          />
          <div class="text-xs text-muted mt-1 text-right">
            {{ description.length }} / 500
          </div>
        </div>

        <!-- Language ──────────────────────────────────────────── -->
        <div>
          <label
            for="newdoc-language"
            class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
          >
            {{ t('newDoc.languageLabel') }}
          </label>
          <UInputMenu
            id="newdoc-language"
            v-model="languageModel"
            :items="languageItems"
            :placeholder="t('documentPanel.language.placeholder')"
            :create-item="true"
            :create-item-position="'bottom'"
            value-key="value"
            data-testid="newdoc-language-input"
            class="w-full"
            @create="(text: string) => languageModel = onCreateLanguage(text)"
          />
        </div>

        <!-- Audience ──────────────────────────────────────────── -->
        <div>
          <label
            for="newdoc-audience"
            class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
          >
            {{ t('newDoc.audienceLabel') }}
          </label>
          <USelect
            id="newdoc-audience"
            v-model="audience"
            :items="audienceItems"
            data-testid="newdoc-audience-select"
            class="w-full"
          />
          <p
            v-if="audienceItems.find(i => i.value === audience)"
            class="text-xs text-toned mt-1.5"
          >
            {{ audienceItems.find(i => i.value === audience)?.description }}
          </p>
        </div>

        <!-- Template ──────────────────────────────────────────── -->
        <div>
          <label
            class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
          >
            {{ t('newDoc.templateLabel') }}
          </label>
          <p class="text-xs text-toned mb-2">
            {{ t('newDoc.templateHelp') }}
          </p>
          <div
            class="grid grid-cols-2 gap-2"
            data-testid="newdoc-template-grid"
          >
            <button
              v-for="tpl in TEMPLATES"
              :key="tpl.id"
              type="button"
              :data-testid="`newdoc-template-card-${tpl.id}`"
              class="text-left rounded-md border p-2.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :class="templateId === tpl.id
                ? 'border-primary bg-elevated/40'
                : 'border-default'"
              @click="templateId = tpl.id"
            >
              <div class="flex items-center gap-2 mb-1">
                <UIcon
                  :name="tpl.icon"
                  class="size-4 text-muted shrink-0"
                />
                <span class="text-sm font-semibold truncate">
                  {{ t(tpl.labelKey) }}
                </span>
              </div>
              <p class="text-xs text-muted leading-snug line-clamp-2">
                {{ t(tpl.descriptionKey) }}
              </p>
            </button>
          </div>
        </div>

        <!-- Theme preset ──────────────────────────────────────── -->
        <div>
          <label
            class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
          >
            {{ t('newDoc.themeLabel') }}
          </label>
          <p class="text-xs text-toned mb-2">
            {{ t('newDoc.themeHelp') }}
          </p>
          <div
            class="grid grid-cols-2 gap-2"
            data-testid="newdoc-theme-grid"
          >
            <button
              v-for="preset in THEME_PRESETS"
              :key="preset.id"
              type="button"
              :data-testid="`newdoc-theme-card-${preset.id}`"
              class="text-left rounded-md border p-2.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :class="themePreset === preset.id
                ? 'border-primary bg-elevated/40'
                : 'border-default'"
              @click="themePreset = preset.id"
            >
              <div class="flex items-center gap-2 mb-1">
                <span
                  class="size-3 rounded-full shrink-0"
                  :style="{ backgroundColor: preset.theme.color.brand }"
                />
                <span
                  class="text-sm font-semibold truncate"
                  :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
                >
                  {{ t(`theme.presets.${preset.id}.name`) }}
                </span>
              </div>
              <p class="text-xs text-muted leading-snug line-clamp-2">
                {{ t(`theme.presets.${preset.id}.description`) }}
              </p>
            </button>
          </div>
        </div>
      </form>
    </template>

    <template #footer>
      <div class="flex items-center justify-between w-full gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="submitting"
          data-testid="newdoc-submit-blank"
          @click="submit(true)"
        >
          {{ t('newDoc.skip') }}
        </UButton>
        <div class="flex items-center gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="submitting"
            data-testid="newdoc-cancel"
            @click="emit('update:open', false)"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            :loading="submitting"
            data-testid="newdoc-submit-create"
            @click="submit(false)"
          >
            {{ t('newDoc.create') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
