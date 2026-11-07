<script setup lang="ts">
import { jsonEqual } from '~~/shared/utils/jsonEqual'
import type { DocTheme } from '~~/shared/types/theme'
import { AUDIENCE_KINDS, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_PRESETS, LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS, THEME_PRESET_CATEGORIES, type ThemePresetCategory } from '~~/shared/utils/themePresets'
import { themeThumbnailUrl } from '~~/shared/utils/themeThumbnails'
import { THEME_FONTS, fontStylesheetUrls } from '~~/shared/utils/themeFonts'
import { DEFAULT_TEMPLATE_ID, TEMPLATES, isTemplateId } from '~~/shared/templates'
import type { TabsItem } from '@nuxt/ui'

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
 * Dialog shown when the user clicks "New document". Only the title is in
 * view; the rest sits in three collapsed rows that show the current choice
 * as a one-line summary, so a new user sees a name field and a button —
 * and that there ARE options, without having to read them:
 *
 *   - Content — the template skeleton (`templateId`)
 *   - Design  — the theme: page thumbnails of the built-in presets in
 *               audience tabs, the user's saved themes, the workspace default
 *   - Details — description / language / audience (AI prompt context)
 *
 * Content defaults to the Demo document for the first document created in
 * this browser and to Blank afterwards (`FIRST_DOC_KEY`), or to
 * `initialTemplateId` when the caller passes one (the "Use this template"
 * button on /templates/<slug>); `initialThemePreset` does the same for the
 * theme when no workspace default applies.
 */

const props = defineProps<{
  open: boolean
  /** When set, the new doc files into this workspace. */
  workspaceId?: string | null
  /** Template card selected on open (a registered id); `demo` otherwise. */
  initialTemplateId?: string | null
  /** Built-in theme preset selected on open, unless the workspace sets a default. */
  initialThemePreset?: string | null
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
const templateId = ref<string>(DEFAULT_TEMPLATE_ID)

// The first document shows what markoto can do (Demo); after that, people
// want their own page (Blank). Remembered per browser — reset by logout,
// which clears localStorage, and absent in private windows: then the demo
// shows once more, which is harmless.
const FIRST_DOC_KEY = 'markoto-created-first-doc'
function hasCreatedDoc(): boolean {
  try {
    return globalThis.localStorage?.getItem(FIRST_DOC_KEY) === '1'
  } catch {
    return false
  }
}
function rememberCreatedDoc(): void {
  try {
    globalThis.localStorage?.setItem(FIRST_DOC_KEY, '1')
  } catch { /* storage blocked — the demo shows again next time */ }
}
function defaultTemplateId(): string {
  if (isTemplateId(props.initialTemplateId)) return props.initialTemplateId
  return hasCreatedDoc() ? 'blank' : DEFAULT_TEMPLATE_ID
}

// Which option row is expanded (one at a time); all closed on open.
type Section = 'content' | 'design' | 'details'
const openSection = ref<Section | null>(null)
type DesignTab = 'all' | ThemePresetCategory | 'saved'
const designTab = ref<DesignTab>('all')

function setSection(section: Section, open: boolean) {
  openSection.value = open ? section : (openSection.value === section ? null : openSection.value)
}

const { loggedIn } = useUserSession()

// Caller's saved themes — only fetched for logged-in users. Used to
// render personal preset cards alongside the built-ins below, and to
// match a workspace default that points at one of them.
interface SavedTheme {
  themeId: string
  name: string
  description?: string
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

// `immediate`: the home page and MarketingStartButton mount this dialog
// on first use with `open` already true (useNewDocDialog), so the reset +
// pre-selection must also run for the initial value.
watch(() => props.open, async (next) => {
  if (!next) return
  anonDoc.prepare()
  title.value = ''
  description.value = ''
  audience.value = 'casual'
  templateId.value = defaultTemplateId()
  openSection.value = null
  designTab.value = 'all'
  languageModel.value = defaultLanguageItem()
  // Pull saved themes + workspace default fresh on every open so a
  // theme just-saved in the editor is immediately pickable here.
  await loadThemeContext()
  // Pre-select the workspace default if one is set. Otherwise the
  // caller's preset, else the markoto preset (the brand default).
  if (workspaceDefaultTheme.value) {
    themeChoice.value = matchThemeChoice(workspaceDefaultTheme.value)
  } else {
    const preset = THEME_PRESETS.find(p => p.id === props.initialThemePreset)
    themeChoice.value = { kind: 'preset', id: preset?.id ?? 'markoto' }
  }
}, { immediate: true })

const audienceItems = computed(() => AUDIENCE_KINDS.map(kind => ({
  label: t(`audiences.${kind}.label`),
  description: t(`audiences.${kind}.description`),
  value: kind
})))

// Design picker tabs: everything, one tab per audience that has presets,
// and the user's own saved themes.
const designTabs = computed<TabsItem[]>(() => [
  { label: t('newDoc.designTabs.all'), value: 'all' },
  ...THEME_PRESET_CATEGORIES
    .filter(c => THEME_PRESETS.some(p => p.category === c))
    .map(c => ({ label: t(`newDoc.designTabs.${c}`), value: c })),
  ...(savedThemes.value.length ? [{ label: t('newDoc.designTabs.saved'), value: 'saved' }] : [])
])
const visiblePresets = computed(() => {
  if (designTab.value === 'saved') return []
  if (designTab.value === 'all') return THEME_PRESETS
  return THEME_PRESETS.filter(p => p.category === designTab.value)
})
const showSaved = computed(() => designTab.value === 'all' || designTab.value === 'saved')

// One-line summaries on the collapsed rows.
const contentSummary = computed(() => {
  const tpl = TEMPLATES.find(x => x.id === templateId.value)
  return tpl ? t(tpl.labelKey) : ''
})
const designSummary = computed(() => {
  const choice = themeChoice.value
  if (choice.kind === 'preset') return t(`theme.presets.${choice.id}.name`)
  if (choice.kind === 'saved') return savedThemes.value.find(s => s.themeId === choice.themeId)?.name ?? ''
  return t('newDoc.themeWorkspaceDefault')
})
const detailsSummary = computed(() => {
  const audienceLabel = t(`audiences.${audience.value}.label`)
  const lang = languageModel.value?.label?.trim()
  return lang ? `${lang} · ${audienceLabel}` : audienceLabel
})

const submitting = ref(false)

async function submit() {
  if (submitting.value) return
  submitting.value = true
  try {
    const body: Record<string, unknown> = {}
    if (props.workspaceId) body.workspaceId = props.workspaceId
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
    const docId = await anonDoc.createDocument(body)
    rememberCreatedDoc()
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
        class="space-y-4"
        @submit.prevent="submit()"
      >
        <!-- Title: the one thing in view ─────────────────────── -->
        <div>
          <label
            for="newdoc-title"
            class="sr-only"
          >
            {{ t('newDoc.titleLabel') }}
          </label>
          <UInput
            id="newdoc-title"
            v-model="title"
            :placeholder="t('newDoc.titlePlaceholder')"
            :maxlength="255"
            size="xl"
            data-testid="newdoc-title-input"
            class="w-full"
            autofocus
          />
        </div>

        <!-- Options: collapsed rows with the current choice ────── -->
        <div class="rounded-lg border border-default divide-y divide-default">
          <!-- Content (template) -->
          <UCollapsible
            :open="openSection === 'content'"
            @update:open="(v: boolean) => setSection('content', v)"
          >
            <button
              type="button"
              data-testid="newdoc-section-content"
              class="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
            >
              <UIcon
                name="i-lucide-file-text"
                class="size-4 text-muted shrink-0"
              />
              <span class="text-sm font-medium">{{ t('newDoc.sections.content') }}</span>
              <span
                class="ms-auto text-sm text-muted truncate"
                data-testid="newdoc-section-content-summary"
              >{{ contentSummary }}</span>
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 text-dimmed shrink-0 transition-transform group-data-[state=open]:rotate-180"
              />
            </button>
            <template #content>
              <div class="px-3 pb-3 pt-1">
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
                    :aria-pressed="templateId === tpl.id"
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
            </template>
          </UCollapsible>

          <!-- Design (theme) -->
          <UCollapsible
            :open="openSection === 'design'"
            @update:open="(v: boolean) => setSection('design', v)"
          >
            <button
              type="button"
              data-testid="newdoc-section-design"
              class="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
            >
              <UIcon
                name="i-lucide-palette"
                class="size-4 text-muted shrink-0"
              />
              <span class="text-sm font-medium">{{ t('newDoc.sections.design') }}</span>
              <span
                class="ms-auto text-sm text-muted truncate"
                data-testid="newdoc-section-design-summary"
              >{{ designSummary }}</span>
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 text-dimmed shrink-0 transition-transform group-data-[state=open]:rotate-180"
              />
            </button>
            <template #content>
              <div class="px-3 pb-3 pt-1">
                <p class="text-xs text-toned mb-2">
                  {{ t('newDoc.themeHelp') }}
                </p>
                <UTabs
                  v-model="designTab"
                  :items="designTabs"
                  :content="false"
                  size="xs"
                  variant="link"
                  class="mb-3 overflow-x-auto"
                  data-testid="newdoc-design-tabs"
                />
                <div
                  class="grid grid-cols-2 sm:grid-cols-3 gap-2"
                  data-testid="newdoc-theme-grid"
                >
                  <!-- Workspace-default "inherit" card. Only shown when
                       filing into a workspace whose default matches no
                       built-in or saved theme of this user; a match
                       lights up that card instead. -->
                  <button
                    v-if="workspaceDefaultTheme && themeChoice.kind === 'inherit' && designTab === 'all'"
                    type="button"
                    data-testid="newdoc-theme-card-inherit"
                    aria-pressed="true"
                    class="text-left rounded-md border p-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary border-primary bg-elevated/40"
                  >
                    <div class="aspect-[3/4] rounded-sm ring-1 ring-default bg-white flex flex-col overflow-hidden">
                      <div
                        class="h-2 shrink-0"
                        :style="{ backgroundColor: workspaceDefaultTheme.color.brand }"
                      />
                      <span
                        class="m-auto text-3xl text-neutral-800"
                        :style="{ fontFamily: `'${workspaceDefaultTheme.headings.font}', system-ui, sans-serif` }"
                      >Aa</span>
                    </div>
                    <div class="mt-1.5 px-0.5 text-xs font-semibold truncate">
                      {{ t('newDoc.themeWorkspaceDefault') }}
                    </div>
                    <p class="px-0.5 text-[11px] text-muted leading-snug line-clamp-2">
                      {{ t('newDoc.themeWorkspaceDefaultHelp') }}
                    </p>
                  </button>

                  <!-- The user's saved themes: no page picture, a brand
                       stripe + "Aa" in their heading font instead. -->
                  <template v-if="showSaved">
                    <button
                      v-for="saved in savedThemes"
                      :key="saved.themeId"
                      type="button"
                      :data-testid="`newdoc-theme-card-saved-${saved.themeId}`"
                      class="text-left rounded-md border p-1.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      :class="themeChoice.kind === 'saved' && themeChoice.themeId === saved.themeId
                        ? 'border-primary bg-elevated/40'
                        : 'border-default'"
                      :aria-pressed="themeChoice.kind === 'saved' && themeChoice.themeId === saved.themeId"
                      @click="themeChoice = { kind: 'saved', themeId: saved.themeId }"
                    >
                      <div class="aspect-[3/4] rounded-sm ring-1 ring-default bg-white flex flex-col overflow-hidden">
                        <div
                          class="h-2 shrink-0"
                          :style="{ backgroundColor: saved.theme.color.brand }"
                        />
                        <span
                          class="m-auto text-3xl text-neutral-800"
                          :style="{ fontFamily: `'${saved.theme.headings.font}', system-ui, sans-serif` }"
                        >Aa</span>
                      </div>
                      <div
                        class="mt-1.5 px-0.5 text-xs font-semibold truncate"
                        :style="{ fontFamily: `'${saved.theme.headings.font}', system-ui, sans-serif` }"
                      >
                        {{ saved.name }}
                      </div>
                      <p
                        class="px-0.5 text-[11px] text-muted leading-snug line-clamp-2 break-words"
                        :data-testid="`newdoc-theme-card-saved-description-${saved.themeId}`"
                      >
                        {{ saved.description || t('theme.saved.fallbackDescription', { heading: saved.theme.headings.font, body: saved.theme.body.font }) }}
                      </p>
                    </button>
                  </template>

                  <!-- Built-in presets: a picture of their first page
                       (`make theme-thumbs`), the brand stripe until one
                       is rendered. -->
                  <button
                    v-for="preset in visiblePresets"
                    :key="preset.id"
                    type="button"
                    :data-testid="`newdoc-theme-card-${preset.id}`"
                    class="text-left rounded-md border p-1.5 hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    :class="themeChoice.kind === 'preset' && themeChoice.id === preset.id
                      ? 'border-primary bg-elevated/40'
                      : 'border-default'"
                    :aria-pressed="themeChoice.kind === 'preset' && themeChoice.id === preset.id"
                    @click="themeChoice = { kind: 'preset', id: preset.id }"
                  >
                    <div class="aspect-[3/4] rounded-sm ring-1 ring-default bg-white overflow-hidden flex flex-col">
                      <img
                        v-if="themeThumbnailUrl(preset.id)"
                        :src="themeThumbnailUrl(preset.id) ?? undefined"
                        alt=""
                        loading="lazy"
                        decoding="async"
                        class="w-full h-full object-cover object-top"
                      >
                      <template v-else>
                        <div
                          class="h-2 shrink-0"
                          :style="{ backgroundColor: preset.theme.color.brand }"
                        />
                        <span
                          class="m-auto text-3xl text-neutral-800"
                          :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
                        >Aa</span>
                      </template>
                    </div>
                    <div
                      class="mt-1.5 px-0.5 text-xs font-semibold truncate"
                      :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
                    >
                      {{ t(`theme.presets.${preset.id}.name`) }}
                    </div>
                    <p class="px-0.5 text-[11px] text-muted leading-snug line-clamp-2">
                      {{ t(`theme.presets.${preset.id}.description`) }}
                    </p>
                  </button>
                </div>
              </div>
            </template>
          </UCollapsible>

          <!-- Details (AI context) -->
          <UCollapsible
            :open="openSection === 'details'"
            @update:open="(v: boolean) => setSection('details', v)"
          >
            <button
              type="button"
              data-testid="newdoc-section-details"
              class="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
            >
              <UIcon
                name="i-lucide-sliders-horizontal"
                class="size-4 text-muted shrink-0"
              />
              <span class="text-sm font-medium">{{ t('newDoc.sections.details') }}</span>
              <span
                class="ms-auto text-sm text-muted truncate"
                data-testid="newdoc-section-details-summary"
              >{{ detailsSummary }}</span>
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 text-dimmed shrink-0 transition-transform group-data-[state=open]:rotate-180"
              />
            </button>
            <template #content>
              <div class="px-3 pb-3 pt-1 space-y-4">
                <p class="text-xs text-toned">
                  {{ t('newDoc.detailsHelp') }}
                </p>
                <div>
                  <label
                    for="newdoc-description"
                    class="block text-xs font-semibold uppercase tracking-wide text-muted mb-1.5"
                  >
                    {{ t('newDoc.descriptionLabel') }}
                  </label>
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
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  </div>
                </div>
                <p
                  v-if="audienceItems.some(i => i.value === audience)"
                  class="text-xs text-toned -mt-2"
                >
                  {{ audienceItems.find(i => i.value === audience)?.description }}
                </p>
              </div>
            </template>
          </UCollapsible>
        </div>
      </form>
    </template>

    <template #footer>
      <div class="flex items-center justify-end w-full gap-2">
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
          @click="submit()"
        >
          {{ t('newDoc.create') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
