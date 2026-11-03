<script setup lang="ts">
import { jsonEqual } from '~~/shared/utils/jsonEqual'
import type { DocTheme } from '~~/shared/types/theme'
import { AUDIENCE_KINDS, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_PRESETS, LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { THEME_FONTS, fontStylesheetUrls } from '~~/shared/utils/themeFonts'
import { TEMPLATES } from '~~/shared/templates'

// Same trick as ThemeEditorPanel — link every picker font's (same-origin)
// stylesheet so each preset card can render its heading in its actual
// font face. Otherwise we'd see "Modern" / "Academic Paper" / etc. all in
// the system fallback and lose the visual signal. The stylesheets only
// declare @font-face rules; a font file downloads once text uses it.
if (import.meta.client) {
  useHead({
    link: fontStylesheetUrls(THEME_FONTS.map(f => f.name)).map(href => ({
      key: `newdoc-theme-font-preview-${href}`,
      rel: 'stylesheet',
      href
    }))
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
const { showError } = useErrorHandler()
// Anonymous visitors pass the terms + bot-check gate on create; the
// solver starts warming up as soon as the dialog opens.
const anonDoc = useAnonDocCreate()

// Form state. Resets on open so reopening doesn't carry stale values.
const title = ref('')
const description = ref('')
const audience = ref<AudienceKind>('casual')
// Theme selection: a single tagged-union ref so the dialog can pick a
// built-in preset id ('preset:modern'), one of the user's saved themes
// ('saved:abc123'), or a workspace default that doesn't match any
// known preset ('inherit'). The submit handler unpacks this back into
// `themePreset` or `themeId` for the API.
type ThemeChoice
  = | { kind: 'preset', id: string }
    | { kind: 'saved', themeId: string }
    | { kind: 'inherit' }
const themeChoice = ref<ThemeChoice>({ kind: 'preset', id: 'markoto' })
const templateId = ref<string>('blank')

const { loggedIn } = useUserSession()

// Caller's saved themes — only fetched for logged-in users. Used to
// render personal preset cards alongside the built-ins below, and to
// match a workspace default that points at one of them.
interface SavedTheme {
  themeId: string
  name: string
  theme: DocTheme
  createdAt: string
  updatedAt: string
}
const savedThemes = ref<SavedTheme[]>([])

// Workspace default theme (when filing into a workspace). Drives the
// "inherit" choice: pre-selected on open IF the workspace has set a
// default. Compared by deep-equal to built-ins / saved themes so the
// matching card lights up too.
const workspaceDefaultTheme = ref<DocTheme | null>(null)

async function loadThemeContext() {
  // 1. The user's saved themes — only meaningful when logged in.
  if (loggedIn.value) {
    try {
      const res = await $fetch<{ themes: SavedTheme[] }>('/api/themes')
      savedThemes.value = res.themes
    } catch { /* non-fatal — list stays empty */ }
  } else {
    savedThemes.value = []
  }
  // 2. The workspace default — only when filing into a workspace.
  if (props.workspaceId) {
    try {
      const res = await $fetch<{ workspace: { defaultTheme: DocTheme | null } }>(
        `/api/workspaces/${props.workspaceId}`
      )
      workspaceDefaultTheme.value = res.workspace.defaultTheme
    } catch { workspaceDefaultTheme.value = null }
  } else {
    workspaceDefaultTheme.value = null
  }
}

// Map a theme JSONB to a known choice (built-in preset / saved theme /
// neither). Used when pre-selecting based on the workspace default so
// the matching card lights up if there's one.
// Compared structurally: the workspace default comes back from a jsonb
// column whose key order differs from the in-code preset.
function matchThemeChoice(theme: DocTheme): ThemeChoice {
  for (const preset of THEME_PRESETS) {
    if (jsonEqual(preset.theme, theme)) return { kind: 'preset', id: preset.id }
  }
  for (const saved of savedThemes.value) {
    if (jsonEqual(saved.theme, theme)) return { kind: 'saved', themeId: saved.themeId }
  }
  return { kind: 'inherit' }
}
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

watch(() => props.open, async (next) => {
  if (!next) return
  anonDoc.prepare()
  title.value = ''
  description.value = ''
  audience.value = 'casual'
  templateId.value = 'blank'
  languageModel.value = defaultLanguageItem()
  // Pull saved themes + workspace default fresh on every open so a
  // theme just-saved in the editor is immediately pickable here.
  await loadThemeContext()
  // Pre-select the workspace default if one is set. Otherwise default
  // to the markoto preset (the brand default).
  if (workspaceDefaultTheme.value) {
    themeChoice.value = matchThemeChoice(workspaceDefaultTheme.value)
  } else {
    themeChoice.value = { kind: 'preset', id: 'markoto' }
  }
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
      // Theme choice → API id. `inherit` sends nothing so the server
      // applies the workspace default (or the markoto schema default
      // for non-workspace docs). The two id paths are mutually
      // exclusive — server rejects passing both.
      if (themeChoice.value.kind === 'preset') {
        body.themePreset = themeChoice.value.id
      } else if (themeChoice.value.kind === 'saved') {
        body.themeId = themeChoice.value.themeId
      }
      if (templateId.value) body.templateId = templateId.value
    }
    const docId = await anonDoc.createDocument(body)
    emit('update:open', false)
    emit('created', docId)
  } catch (e) {
    if (e instanceof AnonGateCancelled) return
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
    :ui="{ content: 'max-w-xl', header: 'shrink-0', title: 'pe-8', description: 'pe-8' }"
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
            v-if="audienceItems.some(i => i.value === audience)"
            class="text-xs text-toned mt-1.5"
          >
            {{ audienceItems.find(i => i.value === audience)?.description }}
          </p>
        </div>

        <!-- Template ──────────────────────────────────────────── -->
        <fieldset class="border-0 p-0 m-0">
          <legend class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">
            {{ t('newDoc.templateLabel') }}
          </legend>
          <p class="text-xs text-toned mb-2">
            {{ t('newDoc.templateHelp') }}
          </p>
          <div
            class="grid grid-cols-1 sm:grid-cols-2 gap-2"
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
        </fieldset>

        <!-- Theme preset ──────────────────────────────────────── -->
        <fieldset class="border-0 p-0 m-0">
          <legend class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5">
            {{ t('newDoc.themeLabel') }}
          </legend>
          <p class="text-xs text-toned mb-2">
            {{ t('newDoc.themeHelp') }}
          </p>
          <div
            class="grid grid-cols-1 sm:grid-cols-2 gap-2"
            data-testid="newdoc-theme-grid"
          >
            <!-- Workspace-default "inherit" card. Only shown when filing
                 into a workspace AND the workspace has a default that
                 doesn't match a built-in or one of the user's saved
                 themes (i.e. an admin set a theme that the current
                 user can't see by name). The "matched" case lights up
                 the corresponding preset/saved card directly so we
                 don't need a duplicate card. -->
            <button
              v-if="workspaceDefaultTheme && themeChoice.kind === 'inherit'"
              type="button"
              data-testid="newdoc-theme-card-inherit"
              class="text-left rounded-md border p-2.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary border-primary bg-elevated/40"
            >
              <div class="flex items-center gap-2 mb-1">
                <span
                  class="size-3 rounded-full shrink-0"
                  :style="{ backgroundColor: workspaceDefaultTheme.color.brand }"
                />
                <span class="text-sm font-semibold truncate">
                  {{ t('newDoc.themeWorkspaceDefault') }}
                </span>
              </div>
              <p class="text-xs text-muted leading-snug line-clamp-2">
                {{ t('newDoc.themeWorkspaceDefaultHelp') }}
              </p>
            </button>

            <!-- User-saved themes. Rendered only when the user is logged
                 in AND has at least one saved preset. Cards have the
                 same shape as built-ins but no description (they're
                 named by the user, not described). -->
            <button
              v-for="saved in savedThemes"
              :key="saved.themeId"
              type="button"
              :data-testid="`newdoc-theme-card-saved-${saved.themeId}`"
              class="text-left rounded-md border p-2.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :class="themeChoice.kind === 'saved' && themeChoice.themeId === saved.themeId
                ? 'border-primary bg-elevated/40'
                : 'border-default'"
              @click="themeChoice = { kind: 'saved', themeId: saved.themeId }"
            >
              <div class="flex items-center gap-2 mb-1">
                <span
                  class="size-3 rounded-full shrink-0"
                  :style="{ backgroundColor: saved.theme.color.brand }"
                />
                <span
                  class="text-sm font-semibold truncate"
                  :style="{ fontFamily: `'${saved.theme.headings.font}', system-ui, sans-serif` }"
                >
                  {{ saved.name }}
                </span>
              </div>
            </button>

            <button
              v-for="preset in THEME_PRESETS"
              :key="preset.id"
              type="button"
              :data-testid="`newdoc-theme-card-${preset.id}`"
              class="text-left rounded-md border p-2.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :class="themeChoice.kind === 'preset' && themeChoice.id === preset.id
                ? 'border-primary bg-elevated/40'
                : 'border-default'"
              :aria-pressed="themeChoice.kind === 'preset' && themeChoice.id === preset.id"
              @click="themeChoice = { kind: 'preset', id: preset.id }"
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
        </fieldset>
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
