<script setup lang="ts">
import { useSavedThemes } from '~/queries/themes'
import type { ApiResponse } from '~/utils/api/client'
import { jsonEqual } from '~~/shared/utils/jsonEqual'
import type { DocTheme } from '~~/shared/types/theme'
import { AUDIENCE_KINDS, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_PRESETS, LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS, type ThemePresetCategory } from '~~/shared/utils/theme/themePresets'
import { THEME_FONTS, fontStylesheetUrls } from '~~/shared/utils/theme/themeFonts'
import { DEFAULT_TEMPLATE_ID, getTemplate, resolveTemplateId } from '~~/shared/templates'

// Same trick as ThemeEditorPanel — link every picker font's (same-origin)
// stylesheet so each preset card can render its heading in its actual
// font face. Otherwise we'd see "Modern" / "arXiv preprint" / etc. all in
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
 * view; the rest sits in two collapsed rows that show the current choice
 * as a one-line summary, so a new user sees a name field and a button —
 * and that there ARE options, without having to read them:
 *
 *   - Template — ONE choice of text + design (`shared/templates`): a
 *                picture of each template's first page in audience tabs.
 *                Blank gets the user's default design (the workspace
 *                default, else markoto); each saved design is offered as
 *                "Blank in <design>". The design can be changed later in
 *                the editor's theme panel.
 *   - Details  — description / language / audience (AI prompt context)
 *
 * The template defaults to Demo for the first document created in this
 * browser and to Blank afterwards (`FIRST_DOC_KEY`), or to
 * `initialTemplateId` when the caller passes one (the "Use this template"
 * button on /templates/<slug>). `initialThemePreset` (same button) puts
 * another built-in design on that template.
 */

const props = defineProps<{
  open: boolean
  /** When set, the new doc files into this workspace. */
  workspaceId?: string | null
  /** Template selected on open (a registered id or alias); demo / blank otherwise. */
  initialTemplateId?: string | null
  /** A built-in design for the initial template instead of its own. */
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
// The choice: a template (its own design; Blank → the default design), or
// "Blank in <saved design>". `designOverride` is a built-in preset the
// caller asked for on the initial template (marketing `::cta theme`); it
// goes as soon as the user picks another card.
type Choice
  = | { kind: 'template', id: string }
    | { kind: 'saved', themeId: string }
    | { kind: 'workspace', templateId: string }
const choice = ref<Choice>({ kind: 'template', id: DEFAULT_TEMPLATE_ID })
const designOverride = ref<string | null>(null)

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
  return resolveTemplateId(props.initialTemplateId) ?? (hasCreatedDoc() ? 'blank' : DEFAULT_TEMPLATE_ID)
}

// Which option row is expanded (one at a time); all closed on open.
type Section = 'template' | 'details'
const openSection = ref<Section | null>(null)
type TemplateTab = 'all' | ThemePresetCategory | 'saved' | 'workspace'
const templateTab = ref<TemplateTab>('all')

function setSection(section: Section, open: boolean) {
  openSection.value = open ? section : (openSection.value === section ? null : openSection.value)
}

// Caller's saved themes — only fetched for logged-in users, once the dialog
// is open (it stays mounted while closed on the workspace page). Each
// becomes a "Blank in <design>" card, and names a workspace default that
// matches one. Saving a theme anywhere invalidates the list.
const { themes: savedThemes } = useSavedThemes(() => props.open)

// Workspace default theme (when filing into a workspace): the design Blank
// gets. Without one, Blank is in the markoto design.
const workspaceDefaultTheme = ref<DocTheme | null>(null)
// The workspace's own templates: a copy of a workspace
// document's current text + design. Only when filing into a workspace.
type WorkspaceTemplate = ApiResponse<'/api/workspaces/:wsId/templates', 'get'>['templates'][number]
const workspaceTemplates = ref<WorkspaceTemplate[]>([])

async function loadThemeContext() {
  // The workspace default — only when filing into a workspace.
  if (props.workspaceId) {
    try {
      const res = await apiFetch('/api/workspaces/:wsId', {
        path: { wsId: props.workspaceId }
      })
      workspaceDefaultTheme.value = res.workspace.defaultTheme
    } catch { workspaceDefaultTheme.value = null }
    try {
      const res = await apiFetch('/api/workspaces/:wsId/templates', { path: { wsId: props.workspaceId } })
      workspaceTemplates.value = res.templates
    } catch { workspaceTemplates.value = [] }
  } else {
    workspaceDefaultTheme.value = null
    workspaceTemplates.value = []
  }
}

// Name of the workspace default for the summary: the built-in preset or
// saved theme it equals, else "Workspace default". Compared structurally:
// the default comes back from a jsonb column whose key order differs from
// the in-code preset.
function workspaceDesignName(theme: DocTheme): string {
  const preset = THEME_PRESETS.find(p => jsonEqual(p.theme, theme))
  if (preset) return t(`theme.presets.${preset.id}.name`)
  const saved = savedThemes.value.find(s => jsonEqual(s.theme, theme))
  return saved?.name ?? t('newDoc.themeWorkspaceDefault')
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
  choice.value = { kind: 'template', id: defaultTemplateId() }
  const override = THEME_PRESETS.find(p => p.id === props.initialThemePreset)?.id ?? null
  designOverride.value = override !== null && override !== getTemplate(choice.value.id)?.design ? override : null
  openSection.value = null
  templateTab.value = 'all'
  languageModel.value = defaultLanguageItem()
  // Pull the workspace default + templates fresh on every open.
  await loadThemeContext()
  // A workspace with its own templates opens on them.
  if (workspaceTemplates.value.length > 0 && !props.initialTemplateId) templateTab.value = 'workspace'
}, { immediate: true })

function pickTemplate(id: string) {
  choice.value = { kind: 'template', id }
  designOverride.value = null
}
function pickWorkspaceTemplate(templateId: string) {
  choice.value = { kind: 'workspace', templateId }
  designOverride.value = null
}
function pickSaved(themeId: string) {
  choice.value = { kind: 'saved', themeId }
  designOverride.value = null
}
const selectedTemplateId = computed(() => choice.value.kind === 'template' ? choice.value.id : null)

const audienceItems = computed(() => AUDIENCE_KINDS.map(kind => ({
  label: t(`audiences.${kind}.label`),
  description: t(`audiences.${kind}.description`),
  value: kind
})))

// One-line summaries on the collapsed rows: the template, plus the design
// where it isn't the template's own (Blank, a `::cta` override).
const templateSummary = computed(() => {
  const c = choice.value
  if (c.kind === 'saved') {
    const name = savedThemes.value.find(s => s.themeId === c.themeId)?.name ?? ''
    return t('newDoc.blankIn', { design: name })
  }
  if (c.kind === 'workspace') return workspaceTemplates.value.find(w => w.id === c.templateId)?.name ?? ''
  const tpl = getTemplate(c.id)
  if (!tpl) return ''
  const name = t(tpl.labelKey)
  if (designOverride.value) return `${name} · ${t(`theme.presets.${designOverride.value}.name`)}`
  if (tpl.design === null) {
    const design = workspaceDefaultTheme.value ? workspaceDesignName(workspaceDefaultTheme.value) : t('theme.presets.markoto.name')
    return `${name} · ${design}`
  }
  return name
})
const blankDescription = computed(() => workspaceDefaultTheme.value
  ? t('newDoc.blankWorkspaceDescription', { design: workspaceDesignName(workspaceDefaultTheme.value) })
  : undefined)
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
    // Template + design → API. A template brings its design (sent as
    // `themePreset`, so an older server applies it too). Blank sends no
    // design in a workspace with a default — the server applies that
    // default — and the markoto preset otherwise. "Blank in <saved
    // design>" sends the saved theme. `themePreset` and `themeId` are
    // mutually exclusive — the server rejects both.
    const c = choice.value
    if (c.kind === 'workspace' && props.workspaceId) {
      // A workspace template copies its document (text + design + images);
      // the title is the one typed here, else the template's name.
      const res = await apiFetch('/api/workspaces/:wsId/templates/:templateId/documents', {
        method: 'post',
        path: { wsId: props.workspaceId, templateId: c.templateId },
        body: trimmedTitle ? { title: trimmedTitle } : {}
      })
      rememberCreatedDoc()
      emit('update:open', false)
      emit('created', res.docId)
      return
    }
    if (c.kind === 'saved') {
      body.templateId = 'blank'
      body.themeId = c.themeId
    } else if (c.kind === 'template') {
      body.templateId = c.id
      const design = designOverride.value ?? getTemplate(c.id)?.design ?? null
      if (design !== null) body.themePreset = design
      else if (!workspaceDefaultTheme.value) body.themePreset = 'markoto'
    }
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
    :content="initialFocus('newdoc-title')"
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
          <UFormField
            :label="t('newDoc.titleLabel')"
            :ui="{ labelWrapper: 'sr-only', container: 'mt-0' }"
          >
            <UInput
              id="newdoc-title"
              v-model="title"
              :placeholder="t('newDoc.titlePlaceholder')"
              :maxlength="255"
              size="xl"
              data-testid="newdoc-title-input"
              class="w-full"
            />
          </UFormField>
        </div>

        <!-- Options: collapsed rows with the current choice ────── -->
        <div class="rounded-lg border border-default divide-y divide-default">
          <!-- Template: text + design, one choice -->
          <UCollapsible
            :open="openSection === 'template'"
            @update:open="(v: boolean) => setSection('template', v)"
          >
            <button
              type="button"
              data-testid="newdoc-section-template"
              class="group flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
            >
              <UIcon
                name="i-lucide-layout-template"
                class="size-4 text-muted shrink-0"
              />
              <span class="text-sm font-medium">{{ t('newDoc.sections.template') }}</span>
              <span
                class="ms-auto text-sm text-muted truncate"
                data-testid="newdoc-section-template-summary"
              >{{ templateSummary }}</span>
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
                <DocumentTemplateGrid
                  v-model:tab="templateTab"
                  testid-prefix="newdoc-template-card-"
                  :saved-tab="savedThemes.length > 0"
                  :workspace-tab="workspaceTemplates.length > 0"
                  :selected-id="selectedTemplateId"
                  :blank-theme="workspaceDefaultTheme"
                  :blank-description="blankDescription"
                  data-testid="newdoc-template-grid"
                  @select="(tpl) => pickTemplate(tpl.id)"
                >
                  <template #before="{ tab: slotTab }">
                    <!-- The workspace's own templates. -->
                    <template v-if="slotTab === 'workspace'">
                      <DocumentPictureCard
                        v-for="wt in workspaceTemplates"
                        :key="wt.id"
                        :testid="`newdoc-template-card-workspace-${wt.id}`"
                        :name="wt.name"
                        :description="wt.description || wt.docTitle"
                        :selected="choice.kind === 'workspace' && choice.templateId === wt.id"
                        :brand="workspaceDefaultTheme?.color.brand ?? '#000000'"
                        :heading-font="workspaceDefaultTheme?.headings.font ?? 'Inter'"
                        @click="pickWorkspaceTemplate(wt.id)"
                      />
                    </template>
                    <!-- The user's saved designs, each as a blank page in
                         it: no page picture, a brand stripe + "Aa" in the
                         heading font instead. -->
                    <template v-if="slotTab === 'all' || slotTab === 'saved'">
                      <DocumentPictureCard
                        v-for="saved in savedThemes"
                        :key="saved.themeId"
                        :testid="`newdoc-template-card-saved-${saved.themeId}`"
                        :name="t('newDoc.blankIn', { design: saved.name })"
                        :description="saved.description || t('theme.saved.fallbackDescription', { heading: saved.theme.headings.font, body: saved.theme.body.font })"
                        :description-testid="`newdoc-template-card-saved-description-${saved.themeId}`"
                        :selected="choice.kind === 'saved' && choice.themeId === saved.themeId"
                        :brand="saved.theme.color.brand"
                        :heading-font="saved.theme.headings.font"
                        @click="pickSaved(saved.themeId)"
                      />
                    </template>
                  </template>
                </DocumentTemplateGrid>
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
                  <UFormField
                    :label="t('newDoc.descriptionLabel')"
                    :ui="{ label: 'text-xs font-semibold uppercase tracking-wide text-muted', container: 'mt-1.5' }"
                  >
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
                  </UFormField>
                  <div class="text-xs text-muted mt-1 text-right">
                    {{ description.length }} / 500
                  </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <UFormField
                      :label="t('newDoc.languageLabel')"
                      :ui="{ label: 'text-xs font-semibold uppercase tracking-wide text-muted', container: 'mt-1.5' }"
                    >
                      <UInputMenu
                        id="newdoc-language"
                        v-model="languageModel"
                        :items="languageItems"
                        :placeholder="t('documentPanel.language.placeholder')"
                        :create-item="true"
                        :create-item-position="'bottom'"
                        data-testid="newdoc-language-input"
                        class="w-full"
                        @create="(text: string) => languageModel = onCreateLanguage(text)"
                      />
                    </UFormField>
                  </div>
                  <div>
                    <UFormField
                      :label="t('newDoc.audienceLabel')"
                      :ui="{ label: 'text-xs font-semibold uppercase tracking-wide text-muted', container: 'mt-1.5' }"
                    >
                      <USelect
                        id="newdoc-audience"
                        v-model="audience"
                        :items="audienceItems"
                        data-testid="newdoc-audience-select"
                        class="w-full"
                      />
                    </UFormField>
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
