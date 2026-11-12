<script setup lang="ts">
import type { SavedTheme } from '~/utils/api/types/themes'
import type { BrandKit } from '~/utils/api/types/brandKit'
import { useSavedThemes } from '~/queries/themes'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { CODE_FONT_NAMES, THEME_FONTS, fontStylesheetUrls } from '~~/shared/utils/theme/themeFonts'
import { brandFontFaceCss, brandFontFamilies } from '~~/shared/utils/theme/brandFonts'
import { brandAssetDocUrl, themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { themeFromPreset, ownCustomCss, type ThemePreset } from '~~/shared/utils/theme/themePresets'
import { loadCustomCssSanitizer, currentAppOrigins } from '~/utils/preview/customCssLoader'

/**
 * Embedded theme editor — sits in the right sidebar slot alongside the
 * activity panel. Layout-shift (not overlay) so the user can keep
 * editing the doc and watch the preview re-paginate as they tweak.
 *
 * Local draft pattern: clones `props.theme` on mount and on every
 * external change (e.g. a remote collaborator). Every section
 * (`components/document/theme/`) binds its fields to the draft through
 * `v-model:theme`; the deep watch fires `update:theme` upstream which
 * calls `setTheme` (Y.js write + debounced PUT).
 */
const props = defineProps<{
  theme: DocTheme
  docId: string
  canEdit: boolean
  /**
   * The document's plan includes custom CSS. False → the CSS section
   * shows the plan notice instead of the editor; any stored CSS is kept
   * but not applied. Optional so other callers default to "allowed".
   */
  customCssAllowed?: boolean
  /**
   * The document's workspace (brand kit): its fonts join the font
   * pickers and its logos the logo / header-image fields. Null outside a
   * workspace, and for guests (who don't see the workspace's kit).
   */
  workspaceId?: string | null
  /**
   * The workspace design is locked: the document renders with it
   * and keeps only its cover text, so the panel shows just that.
   */
  brandLocked?: boolean
  /** The viewer can unlock / change the workspace design (admin). */
  canManageBrand?: boolean
}>()

const emit = defineEmits<{
  'update:theme': [DocTheme]
  'reset': []
  'close': []
}>()

const { t } = useI18n()
const toast = useToast()

const draft = ref<DocTheme>(structuredClone(toRaw(props.theme)))

// Re-clone whenever the external theme changes (initial load, remote
// edit). Without this, the panel keeps showing the old draft after a
// collaborator changes the theme out from under us.
watch(() => props.theme, (next) => {
  if (JSON.stringify(next) !== JSON.stringify(draft.value)) {
    draft.value = structuredClone(toRaw(next))
  }
}, { deep: true })

watch(draft, (next) => {
  if (JSON.stringify(next) === JSON.stringify(props.theme)) return
  emit('update:theme', structuredClone(toRaw(next)))
}, { deep: true })

// Link every picker font's (same-origin) stylesheet so each item in the
// font dropdowns can be rendered in its own face. Only @font-face rules:
// the files download once a dropdown item shows text in that family.
if (import.meta.client) {
  useHead({
    link: fontStylesheetUrls([...THEME_FONTS.map(f => f.name), ...CODE_FONT_NAMES]).map(href => ({
      key: `theme-font-picker-preview-${href}`,
      rel: 'stylesheet',
      href
    }))
  })
}

// Workspace brand kit: fonts + logos the members can pick. Loaded
// once per panel; a failure just leaves the built-in choices.
const brandKit = ref<BrandKit | null>(null)
onMounted(async () => {
  if (!props.workspaceId) return
  try {
    brandKit.value = await apiFetch('/api/workspaces/:wsId/brand', { path: { wsId: props.workspaceId } })
  } catch {
    brandKit.value = null
  }
})
const brandImages = computed(() => brandKit.value?.images ?? [])
const brandFamilies = computed(() => brandFontFamilies(brandKit.value?.fonts ?? []))
// Declare the workspace fonts in the app too, so the picker items show
// in their own face (the document route answers members by session).
useHead(() => ({
  style: brandKit.value?.fonts.length
    ? [{ key: 'theme-brand-fonts', textContent: brandFontFaceCss(brandKit.value.fonts, file => brandAssetDocUrl(props.docId, file)) }]
    : []
}))
// `slot` enables per-item template overrides — Nuxt UI v4 then exposes
// `#<slot>` (custom trigger) and `#<slot>-body` (custom body) for each
// item. Without `slot`, the named templates below are silently ignored.
const sectionItems = computed(() => [
  { value: 'cover', slot: 'cover', label: t('theme.section.cover'), icon: 'i-lucide-book-open-text' },
  { value: 'page', slot: 'page', label: t('theme.section.page'), icon: 'i-lucide-file' },
  { value: 'body', slot: 'body', label: t('theme.section.body'), icon: 'i-lucide-text' },
  { value: 'headings', slot: 'headings', label: t('theme.section.headings'), icon: 'i-lucide-heading' },
  { value: 'meta', slot: 'meta', label: t('theme.section.meta'), icon: 'i-lucide-quote' },
  { value: 'color', slot: 'color', label: t('theme.section.color'), icon: 'i-lucide-palette' },
  { value: 'layout', slot: 'layout', label: t('theme.section.layout'), icon: 'i-lucide-columns-3' },
  { value: 'header', slot: 'header', label: t('theme.section.header'), icon: 'i-lucide-panel-top' },
  { value: 'footer', slot: 'footer', label: t('theme.section.footer'), icon: 'i-lucide-panel-bottom' },
  { value: 'code', slot: 'code', label: t('theme.section.code'), icon: 'i-lucide-code' },
  { value: 'tables', slot: 'tables', label: t('theme.section.tables'), icon: 'i-lucide-table' },
  { value: 'blocks', slot: 'blocks', label: t('theme.section.blocks'), icon: 'i-lucide-image' },
  { value: 'toc', slot: 'toc', label: t('theme.section.toc'), icon: 'i-lucide-list-tree' },
  { value: 'mermaid', slot: 'mermaid', label: t('theme.section.mermaid'), icon: 'i-lucide-workflow' },
  { value: 'alerts', slot: 'alerts', label: t('theme.section.alerts'), icon: 'i-lucide-alert-circle' },
  { value: 'customCss', slot: 'customCss', label: t('theme.section.customCss'), icon: 'i-lucide-braces' }
])

// Section-header entries carry an empty `value` so the union type retains
// the `value` key (USelectMenu's `value-key` prop only accepts keys that
// exist on every item variant). Nuxt UI skips `type: 'label'` items for
// selection, so the empty string is never surfaced as a picked value.
const fontPickerItems = computed(() => [
  ...(brandFamilies.value.length
    ? [
        { type: 'label' as const, label: t('brandKit.workspaceFonts'), value: '' },
        ...brandFamilies.value.map(name => ({ label: name, value: name }))
      ]
    : []),
  { type: 'label' as const, label: t('theme.fonts.sans'), value: '' },
  ...THEME_FONTS.filter(f => f.category === 'sans').map(f => ({ label: f.name, value: f.name })),
  { type: 'label' as const, label: t('theme.fonts.serif'), value: '' },
  ...THEME_FONTS.filter(f => f.category === 'serif').map(f => ({ label: f.name, value: f.name }))
])

// Header/footer token chips insert at the caret of the slot input focused
// last (header or footer), read from its data-slot / data-position.
const activeSlotInput = ref<HTMLInputElement | null>(null)

function insertToken(token: string) {
  const el = activeSlotInput.value
  if (!el) return
  const slot = el.dataset.slot as 'header' | 'footer' | undefined
  const position = el.dataset.position as 'left' | 'center' | 'right' | undefined
  if (!slot || !position) return

  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? el.value.length
  const current = draft.value[slot][position]
  draft.value[slot][position] = current.slice(0, start) + token + current.slice(end)

  void nextTick(() => {
    el.focus()
    const caret = start + token.length
    el.setSelectionRange(caret, caret)
  })
}

function onSlotFocus(el: HTMLInputElement) {
  activeSlotInput.value = el
}

function setCustomCss(css: string) {
  draft.value.customCss = css
}

function doReset() {
  draft.value = structuredClone(defaultTheme)
  emit('reset')
}

function applyPreset(preset: ThemePreset) {
  if (!props.canEdit) return
  // The document's own custom CSS stays; a preset's template CSS (arXiv)
  // goes in front of it, replacing a previous preset's (themeFromPreset).
  const next = themeFromPreset(preset, draft.value.customCss)
  draft.value = structuredClone(next)
  emit('update:theme', next)
  toast.add({
    title: t(`theme.presets.${preset.id}.name`),
    description: t('theme.presets.applied'),
    icon: 'i-lucide-palette',
    color: 'success'
  })
}

// User-saved themes. Anonymous viewers see no saved-themes UI (the server
// returns 401, the list stays empty). Logged-in users get a "Your themes"
// section ABOVE the built-in presets and a "Save current theme" button
// beside the section eyebrow: one-click apply, plus rename + delete.

const { loggedIn } = useUserSession()
// Shared with the new-document dialog and the workspace settings; the
// save / edit / delete dialogs refresh it through their mutations.
const { themes: savedThemes, isLoading: savedLoading } = useSavedThemes()

// Save the CURRENT draft as a new preset, or edit a saved one's name +
// description: both through SavedThemeDialog (the API caps name,
// description and total count, and revalidates the theme).
const themeDialogOpen = ref(false)
const themeDialogMode = ref<'create' | 'edit'>('create')
const themeDialogTarget = ref<SavedTheme | undefined>(undefined)
const themeDialogTheme = shallowRef<DocTheme | undefined>(undefined)

function saveCurrentAsPreset() {
  if (!props.canEdit || !loggedIn.value) return
  themeDialogMode.value = 'create'
  themeDialogTarget.value = undefined
  themeDialogTheme.value = structuredClone(toRaw(draft.value))
  themeDialogOpen.value = true
}

function editSaved(saved: SavedTheme) {
  themeDialogMode.value = 'edit'
  themeDialogTarget.value = saved
  themeDialogTheme.value = undefined
  themeDialogOpen.value = true
}

function onThemeDialogSaved(name: string) {
  if (themeDialogMode.value === 'create') {
    toast.add({
      title: name,
      description: t('theme.saved.savedToast'),
      icon: 'i-lucide-bookmark-check',
      color: 'success'
    })
  }
}

async function applySaved(saved: SavedTheme) {
  if (!props.canEdit) return
  const theme = await adaptThemeToThisDoc(structuredClone(saved.theme))
  draft.value = structuredClone(theme)
  emit('update:theme', theme)
  toast.add({
    title: saved.name,
    description: t('theme.presets.applied'),
    icon: 'i-lucide-palette',
    color: 'success'
  })
}

/**
 * A saved theme can carry custom CSS and a logo / header image that
 * point at the uploads of the document it was saved from. Those can't be
 * used here (and the server would refuse to store them for this doc), so
 * the images are cleared and the CSS rules dropped (with a notice).
 */
async function adaptThemeToThisDoc(saved: DocTheme): Promise<DocTheme> {
  const theme = themeImagesForDoc(saved, props.docId).theme
  if (!theme.customCss?.trim()) return theme
  const { adaptCustomCssToDoc } = await loadCustomCssSanitizer()
  const adapted = adaptCustomCssToDoc(theme.customCss, { docId: props.docId, allowedOrigins: currentAppOrigins() })
  if (adapted.dropped.length === 0) return theme
  toast.add({
    title: t('theme.section.customCss'),
    description: t('theme.customCss.droppedOnApply'),
    icon: 'i-lucide-braces',
    color: 'neutral'
  })
  return { ...theme, customCss: adapted.css }
}

// "Create a design from a document" — the result is saved as one of the
// user's themes (refresh the list) and/or applied to this document.
const designImportOpen = ref(false)
// Mounted on first use: the dialog is its own chunk.
const designImportMounted = ref(false)

function openDesignImport() {
  designImportMounted.value = true
  designImportOpen.value = true
}

function onDesignImportSaved(name: string) {
  toast.add({
    title: name,
    description: t('designImport.savedToast'),
    icon: 'i-lucide-bookmark-check',
    color: 'success'
  })
}

async function onDesignImportApply(imported: DocTheme) {
  if (!props.canEdit) return
  const theme = await adaptThemeToThisDoc(imported)
  draft.value = structuredClone(theme)
  emit('update:theme', theme)
  toast.add({
    title: t('designImport.title'),
    description: t('theme.presets.applied'),
    icon: 'i-lucide-palette',
    color: 'success'
  })
}

// Kept after close so the modal doesn't go blank during its exit animation.
const deleteTarget = ref<SavedTheme | null>(null)
const deleteOpen = ref(false)

function deleteSaved(saved: SavedTheme) {
  deleteTarget.value = saved
  deleteOpen.value = true
}
</script>

<template>
  <div class="flex flex-col h-full bg-muted">
    <!-- Theme panel header — Fraunces title in the editorial register,
         matching Comments / Activity / Document panels. -->
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-palette"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('theme.title') }}
        </h3>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        class="mk-panel-close"
        data-testid="panel-close"
        :aria-label="t('common.close')"
        @click="emit('close')"
      />
    </div>

    <div class="flex-1 overflow-y-auto p-3 min-h-0">
      <div
        v-if="!canEdit"
        class="text-sm text-muted"
      >
        {{ t('theme.readOnly') }}
      </div>

      <!-- Locked workspace design (brand kit): only the cover text
           is the document's own. -->
      <DocumentThemeLockedDesign
        v-else-if="brandLocked"
        v-model:theme="draft"
        :can-manage-brand="canManageBrand"
        :workspace-id="workspaceId"
      />

      <template v-else>
        <!-- User-saved themes. Only visible to logged-in users with at
             least one saved preset. The "Save current theme" button
             sits next to the built-in presets eyebrow below so users
             always see the affordance, even when the list is empty. -->
        <DocumentThemeSavedThemesList
          v-if="loggedIn && savedThemes.length > 0"
          :themes="savedThemes"
          @apply="applySaved"
          @edit="editSaved"
          @delete="deleteSaved"
        />

        <!-- Templates — clickable preset cards at the top of the panel. -->
        <section class="mb-4">
          <!-- Section eyebrow — same JetBrains Mono micro-label
               register as the Document panel's "Description / Language /
               Audience" labels and the Comments panel's section heads. -->
          <div class="flex items-baseline justify-between mb-2 px-1">
            <h4 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
              {{ t('theme.presets.title') }}
            </h4>
            <UButton
              v-if="loggedIn"
              :aria-label="t('theme.saved.saveCurrent')"
              icon="i-lucide-bookmark-plus"
              color="neutral"
              variant="ghost"
              size="xs"
              data-testid="theme-save-current"
              :disabled="savedLoading"
              @click="saveCurrentAsPreset"
            >
              {{ t('theme.saved.saveCurrent') }}
            </UButton>
          </div>
          <UButton
            v-if="loggedIn"
            icon="i-lucide-file-input"
            color="neutral"
            variant="outline"
            size="sm"
            block
            class="mb-3"
            data-testid="theme-design-from-document"
            @click="openDesignImport"
          >
            {{ t('designImport.button') }}
          </UButton>
          <!-- Same picker as the new-document dialog: audience tabs over
               a picture of each preset's first page. A click applies it. -->
          <DocumentThemePresetGrid
            testid-prefix="theme-preset-"
            :columns="2"
            @select="applyPreset"
          />
        </section>

        <UAccordion
          :items="sectionItems"
          :default-value="[]"
          type="multiple"
          :unmount-on-hide="false"
        >
          <!-- Cover page (title sheet) -->
          <template #cover-body>
            <DocumentThemeCoverSection
              v-model:theme="draft"
              :doc-id="docId"
              :brand-images="brandImages"
            />
          </template>

          <!-- Page -->
          <template #page-body>
            <DocumentThemePageSection v-model:theme="draft" />
          </template>

          <!-- Body -->
          <template #body-body>
            <DocumentThemeBodySection
              v-model:theme="draft"
              :font-items="fontPickerItems"
            />
          </template>

          <!-- Headings -->
          <template #headings-body>
            <DocumentThemeHeadingsSection
              v-model:theme="draft"
              :font-items="fontPickerItems"
            />
          </template>

          <!-- Meta (eyebrow font for header/footer/figcaption/footnotes) -->
          <template #meta-body>
            <DocumentThemeMetaSection
              v-model:theme="draft"
              :font-items="fontPickerItems"
            />
          </template>

          <!-- Color: brand (links/marks) + secondary (hairlines/leaders) -->
          <template #color-body>
            <DocumentThemeColorSection v-model:theme="draft" />
          </template>

          <!-- Layout -->
          <template #layout-body>
            <DocumentThemeLayoutSection v-model:theme="draft" />
          </template>

          <!-- Header -->
          <template #header-body>
            <DocumentThemeHeaderSection
              v-model:theme="draft"
              :doc-id="docId"
              :brand-images="brandImages"
              @slot-focus="onSlotFocus"
              @insert-token="insertToken"
            />
          </template>

          <!-- Footer -->
          <template #footer-body>
            <DocumentThemeFooterSection
              v-model:theme="draft"
              @slot-focus="onSlotFocus"
              @insert-token="insertToken"
            />
          </template>

          <!-- Code -->
          <template #code-body>
            <DocumentThemeCodeSection v-model:theme="draft" />
          </template>

          <!-- Tables -->
          <template #tables-body>
            <DocumentThemeTablesSection v-model:theme="draft" />
          </template>

          <!-- Blocks (images + quotes).
               Image radius + max-width are stacked rather than side-by-
               side because the labels wrap unevenly in a w-80 sidebar
               and shift the input boxes to different baselines. Single
               column keeps every input flush. -->
          <template #blocks-body>
            <DocumentThemeBlocksSection v-model:theme="draft" />
          </template>

          <!-- Table of contents -->
          <template #toc-body>
            <DocumentThemeTocSection v-model:theme="draft" />
          </template>

          <!-- Mermaid -->
          <template #mermaid-body>
            <DocumentThemeMermaidSection v-model:theme="draft" />
          </template>

          <!-- Alerts -->
          <template #alerts-body>
            <DocumentThemeAlertsSection v-model:theme="draft" />
          </template>

          <!-- Custom CSS (documents only — preview, print, PDF) -->
          <template #customCss-body>
            <CommonPlanLimitNotice
              v-if="props.customCssAllowed === false"
              :message-key="ownCustomCss(draft.customCss) ? 'plan.feature.customCssPaused' : 'plan.feature.customCss'"
              data-testid="theme-custom-css-plan-notice"
            />
            <DocumentThemeCustomCssSection
              v-else
              :model-value="draft.customCss"
              :doc-id="docId"
              @update:model-value="setCustomCss"
            />
          </template>
        </UAccordion>
      </template>
    </div>

    <div
      v-if="canEdit && !brandLocked"
      class="p-3 border-t border-default shrink-0"
    >
      <UButton
        block
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-ccw"
        @click="doReset"
      >
        {{ t('theme.reset') }}
      </UButton>
    </div>

    <LazyDocumentDesignFromDocumentDialog
      v-if="designImportMounted"
      v-model:open="designImportOpen"
      :can-apply="canEdit"
      @saved="onDesignImportSaved"
      @apply="onDesignImportApply"
    />
    <DocumentSavedThemeDialog
      v-model:open="themeDialogOpen"
      :mode="themeDialogMode"
      :theme="themeDialogTheme"
      :saved-theme="themeDialogTarget"
      @saved="onThemeDialogSaved"
    />
    <DocumentSavedThemeDeleteModal
      v-if="deleteTarget"
      v-model:open="deleteOpen"
      :theme-id="deleteTarget.themeId"
      :name="deleteTarget.name"
    />
  </div>
</template>
