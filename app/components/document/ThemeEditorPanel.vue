<script setup lang="ts">
import type { DocTheme, CodeTheme, MermaidTheme, TocLeaderStyle, TocMaxDepth } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { THEME_FONTS } from '~~/shared/utils/themeFonts'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'

/**
 * Embedded theme editor — sits in the right sidebar slot alongside the
 * activity panel. Layout-shift (not overlay) so the user can keep
 * editing the doc and watch the preview re-paginate as they tweak.
 *
 * Local draft pattern: clones `props.theme` on mount and on every
 * external change (e.g. a remote collaborator). All form controls bind
 * to the draft; deep-watch fires `update:theme` upstream which calls
 * `setTheme` (Y.js write + debounced PUT).
 */
const props = defineProps<{
  theme: DocTheme
  docId: string
  canEdit: boolean
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

// Eagerly load every picker font in a single Google Fonts request so each
// item in the font dropdowns can be rendered in its own face.
if (import.meta.client) {
  const families = THEME_FONTS
    .map(f => `family=${f.name.replaceAll(' ', '+')}:wght@400;500;600;700`)
    .join('&')
  useHead({
    link: [{
      key: 'theme-font-picker-preview',
      rel: 'stylesheet',
      href: `https://fonts.googleapis.com/css2?${families}&display=swap`
    }]
  })
}

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
  { value: 'alerts', slot: 'alerts', label: t('theme.section.alerts'), icon: 'i-lucide-alert-circle' }
])

// Static option lists
const pageSizeItems = [
  { label: 'A4 (210 × 297 mm)', value: 'A4' },
  { label: 'Letter (8.5 × 11 in)', value: 'Letter' },
  { label: 'Legal (8.5 × 14 in)', value: 'Legal' }
]
const orientationItems = computed(() => [
  { label: t('theme.portrait'), value: 'portrait' },
  { label: t('theme.landscape'), value: 'landscape' }
])
const columnItems = computed(() => [
  { label: `1 ${t('theme.column')}`, value: 1 },
  { label: `2 ${t('theme.columns')}`, value: 2 },
  { label: `3 ${t('theme.columns')}`, value: 3 }
])
const blockquoteItems = computed(() => [
  { label: t('theme.blockquote.border'), value: 'border' },
  { label: t('theme.blockquote.background'), value: 'background' },
  { label: t('theme.blockquote.none'), value: 'none' }
])
const hrStyleItems = computed(() => [
  { label: t('theme.hr.rule'), value: 'rule' },
  { label: t('theme.hr.dashed'), value: 'dashed' },
  { label: t('theme.hr.dotted'), value: 'dotted' },
  { label: t('theme.hr.asterism'), value: 'asterism' },
  { label: t('theme.hr.none'), value: 'none' }
])
const coverLayoutItems = computed(() => [
  { label: t('theme.cover.layoutClassic'), value: 'classic' },
  { label: t('theme.cover.layoutEditorial'), value: 'editorial' },
  { label: t('theme.cover.layoutBanner'), value: 'banner' },
  { label: t('theme.cover.layoutMinimal'), value: 'minimal' }
])
const coverAlignItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.center'), value: 'center' },
  { label: t('theme.align.right'), value: 'right' }
])
const headerImagePositionItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.center'), value: 'center' },
  { label: t('theme.align.right'), value: 'right' }
])

// Header image upload — same presigned-PUT flow as the cover logo,
// but writes into `draft.header.imageUrl`. Returns synchronously after
// the upload + confirm round-trip; `headerImageUploading` drives the
// button spinner.
const headerImageUploading = ref(false)
const headerImageError = ref<string | null>(null)
async function uploadHeaderImage(file: File) {
  if (!file) return
  headerImageUploading.value = true
  headerImageError.value = null
  try {
    const { uploadUrl, fileId, key } = await $fetch<{
      uploadUrl: string
      fileId: string
      key: string
    }>('/api/upload/request', {
      method: 'POST',
      body: { docId: props.docId, filename: file.name, contentType: file.type, size: file.size }
    })
    const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
    if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`)
    await $fetch('/api/upload/confirm', { method: 'POST', body: { key } })
    draft.value.header.imageUrl = `/api/files/${props.docId}/${fileId}`
  } catch (e) {
    const err = e as { message?: string }
    headerImageError.value = err.message || 'Upload failed'
  } finally {
    headerImageUploading.value = false
  }
}
function onHeaderImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (f) uploadHeaderImage(f)
  input.value = ''
}
function clearHeaderImage() {
  draft.value.header.imageUrl = ''
}

function addAuthor() {
  if (draft.value.cover.authors.length >= 10) return
  draft.value.cover.authors = [...draft.value.cover.authors, '']
}
function removeAuthor(idx: number) {
  draft.value.cover.authors = draft.value.cover.authors.filter((_, i) => i !== idx)
}

// Logo upload — reuses the existing presigned-PUT image flow keyed
// on docId. Empty string means "no logo uploaded yet"; rendering
// suppresses the <img> tag in that case (no broken image).
const logoUploading = ref(false)
const logoError = ref<string | null>(null)
async function uploadLogo(file: File) {
  if (!file) return
  logoUploading.value = true
  logoError.value = null
  try {
    const { uploadUrl, fileId, key } = await $fetch<{
      uploadUrl: string
      fileId: string
      key: string
    }>('/api/upload/request', {
      method: 'POST',
      body: { docId: props.docId, filename: file.name, contentType: file.type, size: file.size }
    })
    const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
    if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`)
    await $fetch('/api/upload/confirm', { method: 'POST', body: { key } })
    draft.value.brand.logoUrl = `/api/files/${props.docId}/${fileId}`
  } catch (e) {
    const err = e as { message?: string }
    logoError.value = err.message || 'Upload failed'
  } finally {
    logoUploading.value = false
  }
}
function onLogoFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (f) uploadLogo(f)
  input.value = ''
}
function clearLogo() {
  draft.value.brand.logoUrl = ''
}
const textAlignItems = computed(() => [
  { label: t('theme.align.left'), value: 'left' },
  { label: t('theme.align.justify'), value: 'justify' }
])
const headingScaleItems = [
  { label: '1.067 (Minor Second)', value: 1.067 },
  { label: '1.125 (Major Second)', value: 1.125 },
  { label: '1.200 (Minor Third)', value: 1.2 },
  { label: '1.250 (Major Third)', value: 1.25 },
  { label: '1.333 (Perfect Fourth)', value: 1.333 },
  { label: '1.414 (Augmented Fourth)', value: 1.414 },
  { label: '1.500 (Perfect Fifth)', value: 1.5 }
]
const headingWeightItems = [
  { label: 'Regular (400)', value: 400 },
  { label: 'Medium (500)', value: 500 },
  { label: 'Semibold (600)', value: 600 },
  { label: 'Bold (700)', value: 700 },
  { label: 'Extra Bold (800)', value: 800 },
  { label: 'Black (900)', value: 900 }
]
const codeThemeItems = computed(() => [
  { label: 'GitHub Light', value: 'github-light' as CodeTheme },
  { label: 'GitHub Dark', value: 'github-dark' as CodeTheme },
  { label: 'Monokai', value: 'monokai' as CodeTheme },
  { label: 'Dracula', value: 'dracula' as CodeTheme },
  { label: 'Solarized Light', value: 'solarized-light' as CodeTheme },
  { label: 'Solarized Dark', value: 'solarized-dark' as CodeTheme },
  { label: t('theme.code.none'), value: 'none' as CodeTheme }
])
const tableHeaderBgItems = computed(() => [
  { label: t('theme.tables.headerBgBrand'), value: 'brand' },
  { label: t('theme.tables.headerBgMuted'), value: 'muted' },
  { label: t('theme.tables.headerBgNone'), value: 'none' }
])
const tableHeaderColorItems = computed(() => [
  { label: t('theme.tables.headerColorAuto'), value: 'auto' },
  { label: t('theme.tables.headerColorInherit'), value: 'inherit' }
])
const tableBordersItems = computed(() => [
  { label: t('theme.tables.bordersAll'), value: 'all' },
  { label: t('theme.tables.bordersHorizontal'), value: 'horizontal' },
  { label: t('theme.tables.bordersMinimal'), value: 'minimal' },
  { label: t('theme.tables.bordersNone'), value: 'none' }
])
const tocMaxDepthItems = computed(() => [
  { label: t('theme.toc.depth2'), value: 2 as TocMaxDepth },
  { label: t('theme.toc.depth3'), value: 3 as TocMaxDepth },
  { label: t('theme.toc.depth4'), value: 4 as TocMaxDepth }
])
const tocLeaderItems = computed(() => [
  { label: t('theme.toc.leaderDotted'), value: 'dotted' as TocLeaderStyle },
  { label: t('theme.toc.leaderDashed'), value: 'dashed' as TocLeaderStyle },
  { label: t('theme.toc.leaderNone'), value: 'none' as TocLeaderStyle }
])
const mermaidThemeItems = computed(() => [
  { label: t('theme.mermaid.themeDefault'), value: 'default' as MermaidTheme },
  { label: t('theme.mermaid.themeDark'), value: 'dark' as MermaidTheme },
  { label: t('theme.mermaid.themeForest'), value: 'forest' as MermaidTheme },
  { label: t('theme.mermaid.themeNeutral'), value: 'neutral' as MermaidTheme },
  { label: t('theme.mermaid.themeBase'), value: 'base' as MermaidTheme }
])

// Section-header entries carry an empty `value` so the union type retains
// the `value` key (USelectMenu's `value-key` prop only accepts keys that
// exist on every item variant). Nuxt UI skips `type: 'label'` items for
// selection, so the empty string is never surfaced as a picked value.
const fontPickerItems = computed(() => [
  { type: 'label' as const, label: t('theme.fonts.sans'), value: '' },
  ...THEME_FONTS.filter(f => f.category === 'sans').map(f => ({ label: f.name, value: f.name })),
  { type: 'label' as const, label: t('theme.fonts.serif'), value: '' },
  ...THEME_FONTS.filter(f => f.category === 'serif').map(f => ({ label: f.name, value: f.name }))
])

// Header/footer token chips — cursor-aware insertion via data-* attrs.
const tokenChips = [
  { token: '{title}' },
  { token: '{date}' },
  { token: '{page}' },
  { token: '{pages}' }
]

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

  nextTick(() => {
    el.focus()
    const caret = start + token.length
    el.setSelectionRange(caret, caret)
  })
}

function doReset() {
  draft.value = structuredClone(defaultTheme)
  emit('reset')
}

function applyPreset(preset: typeof THEME_PRESETS[number]) {
  if (!props.canEdit) return
  draft.value = structuredClone(preset.theme)
  emit('update:theme', structuredClone(preset.theme))
  toast.add({
    title: t(`theme.presets.${preset.id}.name`),
    description: t('theme.presets.applied'),
    icon: 'i-lucide-palette',
    color: 'success'
  })
}

// ─── User-saved themes ────────────────────────────────────────────
//
// Anonymous viewers see no saved-themes UI (server returns 401, list
// stays empty). Logged-in users get a "Your themes" section ABOVE the
// built-in presets and a "Save current theme" button beside the
// section eyebrow. Same one-click apply, plus rename + delete.

interface SavedTheme {
  themeId: string
  name: string
  theme: DocTheme
  createdAt: string
  updatedAt: string
}

const { loggedIn } = useUserSession()
const savedThemes = ref<SavedTheme[]>([])
const savedLoading = ref(false)

async function refreshSavedThemes() {
  if (!loggedIn.value) {
    savedThemes.value = []
    return
  }
  savedLoading.value = true
  try {
    const res = await $fetch<{ themes: SavedTheme[] }>('/api/themes')
    savedThemes.value = res.themes
  } catch {
    // Non-fatal — anonymous users hit 401 here, which we already
    // handle via the loggedIn guard. Other errors silently keep the
    // list empty so the rest of the panel still works.
  } finally {
    savedLoading.value = false
  }
}

onMounted(() => {
  // onMounted only fires client-side, so the previous
  // `import.meta.client` guard is implicit here.
  refreshSavedThemes().catch(() => { /* swallowed inside refreshSavedThemes */ })
})

// Save the CURRENT draft as a new preset. Prompts for a name; the API
// caps name + total count and revalidates the theme via DocThemeSchema.
async function saveCurrentAsPreset() {
  if (!props.canEdit || !loggedIn.value) return
  const name = (globalThis.window !== undefined
    ? globalThis.prompt(t('theme.saved.namePrompt'), '')
    : null
  )?.trim()
  if (!name) return
  try {
    await $fetch('/api/themes', {
      method: 'POST',
      body: { name, theme: toRaw(draft.value) }
    })
    await refreshSavedThemes()
    toast.add({
      title: name,
      description: t('theme.saved.savedToast'),
      icon: 'i-lucide-bookmark-check',
      color: 'success'
    })
  } catch (e) {
    const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
    toast.add({
      title: t('theme.saved.saveFailedTitle'),
      description: err.data?.message ?? err.statusMessage ?? err.message ?? '',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

function applySaved(saved: SavedTheme) {
  if (!props.canEdit) return
  draft.value = structuredClone(saved.theme)
  emit('update:theme', structuredClone(saved.theme))
  toast.add({
    title: saved.name,
    description: t('theme.presets.applied'),
    icon: 'i-lucide-palette',
    color: 'success'
  })
}

async function renameSaved(saved: SavedTheme) {
  if (globalThis.window === undefined) return
  const next = globalThis.prompt(t('theme.saved.renamePrompt'), saved.name)?.trim()
  if (!next || next === saved.name) return
  try {
    await $fetch(`/api/themes/${saved.themeId}`, {
      method: 'PATCH',
      body: { name: next }
    })
    await refreshSavedThemes()
  } catch (e) {
    const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
    toast.add({
      title: t('theme.saved.renameFailedTitle'),
      description: err.data?.message ?? err.statusMessage ?? err.message ?? '',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

async function deleteSaved(saved: SavedTheme) {
  if (globalThis.window === undefined) return
  if (!globalThis.confirm(t('theme.saved.deleteConfirm', { name: saved.name }))) return
  try {
    await $fetch(`/api/themes/${saved.themeId}`, { method: 'DELETE' })
    await refreshSavedThemes()
  } catch (e) {
    const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
    toast.add({
      title: t('theme.saved.deleteFailedTitle'),
      description: err.data?.message ?? err.statusMessage ?? err.message ?? '',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
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

      <template v-else>
        <!-- User-saved themes. Only visible to logged-in users with at
             least one saved preset. The "Save current theme" button
             sits next to the built-in presets eyebrow below so users
             always see the affordance, even when the list is empty. -->
        <section
          v-if="loggedIn && savedThemes.length > 0"
          class="mb-4"
        >
          <div class="flex items-baseline justify-between mb-2 px-1">
            <h4 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
              {{ t('theme.saved.title') }}
            </h4>
          </div>
          <div class="grid grid-cols-1 gap-2">
            <div
              v-for="saved in savedThemes"
              :key="saved.themeId"
              :data-testid="`theme-saved-${saved.themeId}`"
              class="group relative flex items-stretch gap-1 rounded-md border border-default bg-default hover:border-default/80 transition-colors"
            >
              <button
                type="button"
                class="flex-1 text-left p-3 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                @click="applySaved(saved)"
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
              <div class="flex flex-col justify-center pr-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <UButton
                  :aria-label="t('theme.saved.rename')"
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  @click.stop="renameSaved(saved)"
                />
                <UButton
                  :aria-label="t('theme.saved.delete')"
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="ghost"
                  size="xs"
                  @click.stop="deleteSaved(saved)"
                />
              </div>
            </div>
          </div>
        </section>

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
          <div class="grid grid-cols-1 gap-2">
            <!-- Preset card. `bg-default` (= white in light, sumi-900
                 in dark) so cards pop against the panel's `bg-muted`
                 (sumi-50 in light, sumi-950 in dark) surround. Same
                 contrast pattern as the comment + activity cards. -->
            <button
              v-for="preset in THEME_PRESETS"
              :key="preset.id"
              :data-testid="`theme-preset-${preset.id}`"
              type="button"
              class="text-left rounded-md border border-default bg-default p-3 hover:border-default/80 hover:bg-default/80 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              @click="applyPreset(preset)"
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
        </section>

        <UAccordion
          :items="sectionItems"
          :default-value="[]"
          type="multiple"
          :unmount-on-hide="false"
        >
          <!-- Cover page (title sheet) -->
          <template #cover-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField
                :label="t('theme.cover.enabled')"
                :help="t('theme.cover.enabledHelp')"
              >
                <USwitch
                  v-model="draft.cover.enabled"
                  data-testid="theme-cover-enabled-switch"
                />
              </UFormField>
              <template v-if="draft.cover.enabled">
                <UFormField :label="t('theme.cover.layout')">
                  <USelect
                    v-model="draft.cover.layout"
                    :items="coverLayoutItems"
                    class="w-full"
                    data-testid="theme-cover-layout-select"
                  />
                </UFormField>
                <UFormField :label="t('theme.cover.align')">
                  <USelect
                    v-model="draft.cover.align"
                    :items="coverAlignItems"
                    class="w-full"
                    data-testid="theme-cover-align-select"
                  />
                </UFormField>
                <UFormField
                  :label="t('theme.cover.titleSize')"
                  :help="`${draft.cover.titleSize.toFixed(2)}em`"
                >
                  <USlider
                    v-model="draft.cover.titleSize"
                    :min="0.6"
                    :max="4"
                    :step="0.05"
                  />
                </UFormField>
                <UFormField
                  v-if="draft.cover.showSubtitle"
                  :label="t('theme.cover.subtitleSize')"
                  :help="`${draft.cover.subtitleSize.toFixed(2)}em`"
                >
                  <USlider
                    v-model="draft.cover.subtitleSize"
                    :min="0.5"
                    :max="2.5"
                    :step="0.05"
                  />
                </UFormField>
                <UFormField :label="t('theme.cover.showTitle')">
                  <USwitch v-model="draft.cover.showTitle" />
                </UFormField>
                <UFormField :label="t('theme.cover.showSubtitle')">
                  <USwitch
                    v-model="draft.cover.showSubtitle"
                    data-testid="theme-cover-show-subtitle-switch"
                  />
                </UFormField>
                <UFormField
                  v-if="draft.cover.showSubtitle"
                  :label="t('theme.cover.subtitle')"
                >
                  <UInput
                    v-model="draft.cover.subtitle"
                    maxlength="200"
                    class="w-full"
                    data-testid="theme-cover-subtitle-input"
                  />
                </UFormField>
                <UFormField :label="t('theme.cover.showDate')">
                  <USwitch v-model="draft.cover.showDate" />
                </UFormField>
                <UFormField :label="t('theme.cover.showAuthors')">
                  <USwitch
                    v-model="draft.cover.showAuthors"
                    data-testid="theme-cover-show-authors-switch"
                  />
                </UFormField>
                <UFormField :label="t('theme.cover.showLogo')">
                  <USwitch v-model="draft.cover.showLogo" />
                </UFormField>
                <UFormField
                  v-if="draft.cover.showLogo"
                  :label="t('theme.brand.logo')"
                  :help="t('theme.brand.logoHelp')"
                >
                  <div class="space-y-2">
                    <div
                      v-if="draft.brand.logoUrl"
                      class="flex items-center gap-3 p-2 border border-default rounded"
                    >
                      <img
                        :src="draft.brand.logoUrl"
                        alt="Logo preview"
                        class="border border-default rounded bg-default"
                        :style="{ height: `${draft.brand.logoHeight}px`, maxWidth: '120px', objectFit: 'contain' }"
                      >
                      <UButton
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-x"
                        size="xs"
                        @click="clearLogo"
                      >
                        {{ t('theme.brand.clearLogo') }}
                      </UButton>
                    </div>
                    <label class="flex">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        class="hidden"
                        @change="onLogoFile"
                      >
                      <UButton
                        as="span"
                        color="neutral"
                        variant="outline"
                        icon="i-lucide-upload"
                        :loading="logoUploading"
                        block
                      >
                        {{ draft.brand.logoUrl ? t('theme.brand.replaceLogo') : t('theme.brand.uploadLogo') }}
                      </UButton>
                    </label>
                    <p
                      v-if="logoError"
                      class="text-xs text-error"
                    >
                      {{ logoError }}
                    </p>
                  </div>
                </UFormField>
                <UFormField
                  v-if="draft.cover.showLogo && draft.brand.logoUrl"
                  :label="t('theme.brand.logoHeight')"
                >
                  <UInputNumber
                    v-model="draft.brand.logoHeight"
                    :min="8"
                    :max="80"
                    :step="2"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  v-if="draft.cover.showAuthors"
                  :label="t('theme.cover.authors')"
                  :help="t('theme.cover.authorsHelp')"
                >
                  <div class="space-y-2">
                    <div
                      v-for="(_, idx) in draft.cover.authors"
                      :key="idx"
                      class="flex gap-2"
                    >
                      <UInput
                        v-model="draft.cover.authors[idx]"
                        :placeholder="t('theme.cover.authorPlaceholder')"
                        maxlength="100"
                        class="flex-1"
                      />
                      <UButton
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-x"
                        :aria-label="t('theme.cover.removeAuthor')"
                        @click="removeAuthor(idx)"
                      />
                    </div>
                    <UButton
                      v-if="draft.cover.authors.length < 10"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-plus"
                      block
                      @click="addAuthor"
                    >
                      {{ t('theme.cover.addAuthor') }}
                    </UButton>
                  </div>
                </UFormField>
              </template>
            </div>
          </template>

          <!-- Page -->
          <template #page-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.page.size')">
                <USelect
                  v-model="draft.page.size"
                  :items="pageSizeItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.page.orientation')">
                <USelect
                  v-model="draft.page.orientation"
                  :items="orientationItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.page.margin')"
                :help="t('theme.page.marginHelp')"
              >
                <UInputNumber
                  v-model="draft.page.margin"
                  :min="0"
                  :max="60"
                  :step="1"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Body -->
          <template #body-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.body.font')">
                <USelectMenu
                  v-model="draft.body.font"
                  :items="fontPickerItems"
                  value-key="value"
                  class="w-full"
                  data-testid="theme-body-font-select"
                >
                  <template #item-label="{ item }">
                    <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">{{ item.label }}</span>
                  </template>
                </USelectMenu>
              </UFormField>
              <div class="grid grid-cols-2 gap-3">
                <UFormField :label="t('theme.body.size')">
                  <UInputNumber
                    v-model="draft.body.size"
                    :min="6"
                    :max="24"
                    :step="0.5"
                    class="w-full"
                  />
                </UFormField>
                <UFormField :label="t('theme.body.lineHeight')">
                  <UInputNumber
                    v-model="draft.body.lineHeight"
                    :min="0.8"
                    :max="3"
                    :step="0.05"
                    class="w-full"
                  />
                </UFormField>
              </div>
              <UFormField
                :label="t('theme.body.textAlign')"
                :help="t('theme.body.textAlignHelp')"
              >
                <USelect
                  v-model="draft.body.textAlign"
                  :items="textAlignItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.body.color')">
                <UPopover>
                  <UButton
                    color="neutral"
                    variant="outline"
                    class="w-full justify-start"
                  >
                    <span
                      class="size-4 rounded border border-default"
                      :style="{ backgroundColor: draft.body.color }"
                    />
                    <span class="font-mono text-xs">{{ draft.body.color }}</span>
                  </UButton>
                  <template #content>
                    <UColorPicker
                      v-model="draft.body.color"
                      class="p-2"
                    />
                  </template>
                </UPopover>
              </UFormField>
              <UFormField :label="t('theme.body.background')">
                <UPopover>
                  <UButton
                    color="neutral"
                    variant="outline"
                    class="w-full justify-start"
                  >
                    <span
                      class="size-4 rounded border border-default"
                      :style="{ backgroundColor: draft.body.background }"
                    />
                    <span class="font-mono text-xs">{{ draft.body.background }}</span>
                  </UButton>
                  <template #content>
                    <UColorPicker
                      v-model="draft.body.background"
                      class="p-2"
                    />
                  </template>
                </UPopover>
              </UFormField>
              <UFormField
                :label="t('theme.body.dropCap')"
                :help="t('theme.body.dropCapHelp')"
              >
                <USwitch
                  v-model="draft.body.dropCap"
                  data-testid="theme-body-drop-cap-switch"
                />
              </UFormField>
              <UFormField
                :label="t('theme.body.firstLineIndent')"
                :help="t('theme.body.firstLineIndentHelp')"
              >
                <USwitch v-model="draft.body.firstLineIndent" />
              </UFormField>
              <UFormField :label="t('theme.body.paragraphSpacing')">
                <UInputNumber
                  v-model="draft.body.paragraphSpacing"
                  :min="0"
                  :max="2"
                  :step="0.1"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.body.hyphenate')"
                :help="t('theme.body.hyphenateHelp')"
              >
                <USwitch v-model="draft.body.hyphenate" />
              </UFormField>
            </div>
          </template>

          <!-- Headings -->
          <template #headings-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.headings.font')">
                <USelectMenu
                  v-model="draft.headings.font"
                  :items="fontPickerItems"
                  value-key="value"
                  class="w-full"
                >
                  <template #item-label="{ item }">
                    <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">{{ item.label }}</span>
                  </template>
                </USelectMenu>
              </UFormField>
              <UFormField :label="t('theme.headings.scale')">
                <USelect
                  v-model="draft.headings.scale"
                  :items="headingScaleItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.headings.weight')">
                <USelect
                  v-model="draft.headings.weight"
                  :items="headingWeightItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.headings.color')"
                :help="t('theme.headings.colorHelp')"
              >
                <UPopover>
                  <UButton
                    color="neutral"
                    variant="outline"
                    class="w-full justify-start"
                  >
                    <span
                      class="size-4 rounded border border-default"
                      :style="{ backgroundColor: draft.headings.color }"
                    />
                    <span class="font-mono text-xs">{{ draft.headings.color }}</span>
                  </UButton>
                  <template #content>
                    <UColorPicker
                      v-model="draft.headings.color"
                      class="p-2"
                    />
                  </template>
                </UPopover>
              </UFormField>
              <UFormField :label="t('theme.headings.underline')">
                <USwitch v-model="draft.headings.underline" />
              </UFormField>
              <UFormField :label="t('theme.headings.letterSpacing')">
                <UInputNumber
                  v-model="draft.headings.letterSpacing"
                  :min="-0.05"
                  :max="0.1"
                  :step="0.005"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.headings.lineHeight')">
                <UInputNumber
                  v-model="draft.headings.lineHeight"
                  :min="0.9"
                  :max="1.6"
                  :step="0.05"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.headings.spacingScale')"
                :help="t('theme.headings.spacingScaleHelp')"
              >
                <UInputNumber
                  v-model="draft.headings.spacingScale"
                  :min="0.5"
                  :max="2"
                  :step="0.1"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Meta (eyebrow font for header/footer/figcaption/footnotes) -->
          <template #meta-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField
                :label="t('theme.meta.font')"
                :help="t('theme.meta.fontHelp')"
              >
                <USelectMenu
                  v-model="draft.meta.font"
                  :items="fontPickerItems"
                  value-key="value"
                  class="w-full"
                >
                  <template #item-label="{ item }">
                    <span :style="item.value ? { fontFamily: `'${item.value}', sans-serif` } : undefined">{{ item.label }}</span>
                  </template>
                </USelectMenu>
              </UFormField>
            </div>
          </template>

          <!-- Color: brand (links/marks) + secondary (hairlines/leaders) -->
          <template #color-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField
                :label="t('theme.color.brand')"
                :help="t('theme.color.brandHelp')"
              >
                <UPopover>
                  <UButton
                    color="neutral"
                    variant="outline"
                    class="w-full justify-start"
                    data-testid="theme-color-brand-trigger"
                  >
                    <span
                      class="size-4 rounded border border-default"
                      :style="{ backgroundColor: draft.color.brand }"
                    />
                    <span class="font-mono text-xs">{{ draft.color.brand }}</span>
                  </UButton>
                  <template #content>
                    <UColorPicker
                      v-model="draft.color.brand"
                      class="p-2"
                    />
                  </template>
                </UPopover>
              </UFormField>
              <UFormField
                :label="t('theme.color.secondary')"
                :help="t('theme.color.secondaryHelp')"
              >
                <UPopover>
                  <UButton
                    color="neutral"
                    variant="outline"
                    class="w-full justify-start"
                  >
                    <span
                      class="size-4 rounded border border-default"
                      :style="{ backgroundColor: draft.color.secondary }"
                    />
                    <span class="font-mono text-xs">{{ draft.color.secondary }}</span>
                  </UButton>
                  <template #content>
                    <UColorPicker
                      v-model="draft.color.secondary"
                      class="p-2"
                    />
                  </template>
                </UPopover>
              </UFormField>
            </div>
          </template>

          <!-- Layout -->
          <template #layout-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.layout.columns')">
                <USelect
                  v-model="draft.layout.columns"
                  :items="columnItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                v-if="draft.layout.columns > 1"
                :label="t('theme.layout.columnGap')"
              >
                <UInputNumber
                  v-model="draft.layout.columnGap"
                  :min="0"
                  :max="30"
                  :step="1"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Header -->
          <template #header-body>
            <div class="space-y-3 pt-2 pb-4">
              <p class="text-xs text-muted">
                {{ t('theme.runningSlots.help') }}
              </p>
              <UFormField :label="t('theme.runningSlots.left')">
                <UInput
                  v-model="draft.header.left"
                  class="w-full"
                  data-slot="header"
                  data-position="left"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.center')">
                <UInput
                  v-model="draft.header.center"
                  class="w-full"
                  data-slot="header"
                  data-position="center"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.right')">
                <UInput
                  v-model="draft.header.right"
                  class="w-full"
                  data-slot="header"
                  data-position="right"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <div class="flex flex-wrap gap-1.5 pt-1">
                <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
                <UButton
                  v-for="chip in tokenChips"
                  :key="`hdr-${chip.token}`"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @mousedown.prevent
                  @click="insertToken(chip.token)"
                >
                  {{ chip.token }}
                </UButton>
              </div>

              <!-- Header image — companies typically want their logo in
                   the running header on every body page. The cover page's
                   `@page cover-page { @top-X { content: '' } }` rules
                   automatically suppress this on the cover. -->
              <USeparator />
              <UFormField
                :label="t('theme.runningSlots.image')"
                :help="t('theme.runningSlots.imageHelp')"
              >
                <div class="space-y-2">
                  <div
                    v-if="draft.header.imageUrl"
                    class="flex items-center gap-3 p-2 border border-default rounded"
                  >
                    <img
                      :src="draft.header.imageUrl"
                      alt="Header preview"
                      class="border border-default rounded bg-default"
                      :style="{ height: `${draft.header.imageHeight * 1.5}px`, maxWidth: '120px', objectFit: 'contain' }"
                    >
                    <UButton
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-x"
                      size="xs"
                      @click="clearHeaderImage"
                    >
                      {{ t('theme.brand.clearLogo') }}
                    </UButton>
                  </div>
                  <label class="flex">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      class="hidden"
                      @change="onHeaderImageFile"
                    >
                    <UButton
                      as="span"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-upload"
                      size="xs"
                      :loading="headerImageUploading"
                    >
                      {{ draft.header.imageUrl ? t('theme.brand.replaceLogo') : t('theme.runningSlots.uploadImage') }}
                    </UButton>
                  </label>
                  <p
                    v-if="headerImageError"
                    class="text-xs text-rose-600 dark:text-rose-400"
                  >
                    {{ headerImageError }}
                  </p>
                </div>
              </UFormField>
              <UFormField
                v-if="draft.header.imageUrl"
                :label="t('theme.runningSlots.imagePosition')"
              >
                <USelect
                  v-model="draft.header.imagePosition"
                  :items="headerImagePositionItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                v-if="draft.header.imageUrl"
                :label="t('theme.runningSlots.imageHeight')"
                :help="`${draft.header.imageHeight}pt`"
              >
                <USlider
                  v-model="draft.header.imageHeight"
                  :min="6"
                  :max="24"
                  :step="1"
                />
              </UFormField>
            </div>
          </template>

          <!-- Footer -->
          <template #footer-body>
            <div class="space-y-3 pt-2 pb-4">
              <p class="text-xs text-muted">
                {{ t('theme.runningSlots.help') }}
              </p>
              <UFormField :label="t('theme.runningSlots.left')">
                <UInput
                  v-model="draft.footer.left"
                  class="w-full"
                  data-slot="footer"
                  data-position="left"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.center')">
                <UInput
                  v-model="draft.footer.center"
                  class="w-full"
                  data-slot="footer"
                  data-position="center"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <UFormField :label="t('theme.runningSlots.right')">
                <UInput
                  v-model="draft.footer.right"
                  class="w-full"
                  data-slot="footer"
                  data-position="right"
                  @focus="(e: FocusEvent) => activeSlotInput = e.target as HTMLInputElement"
                />
              </UFormField>
              <div class="flex flex-wrap gap-1.5 pt-1">
                <span class="text-xs text-muted self-center mr-1">{{ t('theme.runningSlots.tokens') }}</span>
                <UButton
                  v-for="chip in tokenChips"
                  :key="`ftr-${chip.token}`"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @mousedown.prevent
                  @click="insertToken(chip.token)"
                >
                  {{ chip.token }}
                </UButton>
              </div>
            </div>
          </template>

          <!-- Code -->
          <template #code-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.code.theme')">
                <USelect
                  v-model="draft.code.theme"
                  :items="codeThemeItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.code.fontSize')">
                <UInputNumber
                  v-model="draft.code.fontSize"
                  :min="6"
                  :max="16"
                  :step="0.5"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Tables -->
          <template #tables-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.tables.headerBackground')">
                <USelect
                  v-model="draft.tables.headerBackground"
                  :items="tableHeaderBgItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                v-if="draft.tables.headerBackground !== 'none'"
                :label="t('theme.tables.headerTextColor')"
                :help="t('theme.tables.headerTextColorHelp')"
              >
                <USelect
                  v-model="draft.tables.headerTextColor"
                  :items="tableHeaderColorItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.tables.borders')">
                <USelect
                  v-model="draft.tables.borders"
                  :items="tableBordersItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.tables.zebra')"
                :help="t('theme.tables.zebraHelp')"
              >
                <USwitch v-model="draft.tables.zebra" />
              </UFormField>
              <UFormField :label="t('theme.tables.cellPadding')">
                <UInputNumber
                  v-model="draft.tables.cellPadding"
                  :min="0"
                  :max="24"
                  :step="1"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Blocks (images + quotes).
               Image radius + max-width are stacked rather than side-by-
               side because the labels wrap unevenly in a w-80 sidebar
               and shift the input boxes to different baselines. Single
               column keeps every input flush. -->
          <template #blocks-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField :label="t('theme.blocks.imageRadius')">
                <UInputNumber
                  v-model="draft.blocks.imageRadius"
                  :min="0"
                  :max="32"
                  :step="1"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.blocks.imageMaxWidth')">
                <UInputNumber
                  v-model="draft.blocks.imageMaxWidth"
                  :min="10"
                  :max="100"
                  :step="5"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.blocks.blockquoteStyle')">
                <USelect
                  v-model="draft.blocks.blockquoteStyle"
                  :items="blockquoteItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.blocks.hrStyle')"
                :help="t('theme.blocks.hrStyleHelp')"
              >
                <USelect
                  v-model="draft.blocks.hrStyle"
                  :items="hrStyleItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                v-if="draft.blocks.hrStyle === 'rule' || draft.blocks.hrStyle === 'dashed' || draft.blocks.hrStyle === 'dotted'"
                :label="t('theme.blocks.hrThickness')"
              >
                <UInputNumber
                  v-model="draft.blocks.hrThickness"
                  :min="1"
                  :max="6"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Table of contents -->
          <template #toc-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField
                :label="t('theme.toc.showTitle')"
                :help="t('theme.toc.showTitleHelp')"
              >
                <USwitch v-model="draft.toc.showTitle" />
              </UFormField>
              <UFormField
                :label="t('theme.toc.maxDepth')"
                :help="t('theme.toc.maxDepthHelp')"
              >
                <USelect
                  v-model="draft.toc.maxDepth"
                  :items="tocMaxDepthItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.toc.showPageNumbers')"
                :help="t('theme.toc.showPageNumbersHelp')"
              >
                <USwitch v-model="draft.toc.showPageNumbers" />
              </UFormField>
              <UFormField :label="t('theme.toc.leaderStyle')">
                <USelect
                  v-model="draft.toc.leaderStyle"
                  :items="tocLeaderItems"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Mermaid -->
          <template #mermaid-body>
            <div class="space-y-4 pt-2 pb-4">
              <UFormField
                :label="t('theme.mermaid.theme')"
                :help="t('theme.mermaid.themeHelp')"
              >
                <USelect
                  v-model="draft.mermaid.theme"
                  :items="mermaidThemeItems"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <!-- Alerts -->
          <template #alerts-body>
            <div class="space-y-4 pt-2 pb-4">
              <p class="text-xs text-muted">
                {{ t('theme.alerts.help') }}
              </p>
              <UFormField
                v-for="kind in (['note', 'tip', 'important', 'warning', 'caution'] as const)"
                :key="kind"
                :label="t(`theme.alerts.${kind}`)"
              >
                <UPopover>
                  <UButton
                    color="neutral"
                    variant="outline"
                    class="w-full justify-start"
                  >
                    <span
                      class="size-4 rounded border border-default"
                      :style="{ backgroundColor: draft.alerts[kind] }"
                    />
                    <span class="font-mono text-xs">{{ draft.alerts[kind] }}</span>
                  </UButton>
                  <template #content>
                    <UColorPicker
                      v-model="draft.alerts[kind]"
                      class="p-2"
                    />
                  </template>
                </UPopover>
              </UFormField>
            </div>
          </template>
        </UAccordion>
      </template>
    </div>

    <div
      v-if="canEdit"
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
  </div>
</template>
