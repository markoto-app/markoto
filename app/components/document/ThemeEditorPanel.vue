<script setup lang="ts">
import type { DocTheme, CaptionLabelStyle, CaptionNumbering, CaptionPosition, CodeTheme, CodeBackground, CodeFrame, DateFormat, HeadingLevelKey, HeadingLevels, HeadingLevelStyle, HeadingNumbering, HeadingStyle, MermaidTheme, NumberingDepth, ReferenceStyle, SectionMode, TocLeaderStyle, TocMaxDepth } from '~~/shared/types/theme'
import { HEADING_LEVEL_KEYS } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { CODE_FONT_NAMES, THEME_FONTS, fontStylesheetUrls } from '~~/shared/utils/themeFonts'
import { CODE_OPTION_DEFAULTS, coverDateFormat, headingNumbering, mirrorMargins, numberingDepth, referenceStyle, repeatTitle, resolveCaptions, resolveChapterLabel, resolveHeadingLevel, resolvePageMargins, resolveSectionToken, resolveTitleBlock, runningRule } from '~~/shared/utils/themeOptions'
import { HEADING_SCALE_EXPONENTS } from '~~/shared/utils/themeToCss'
import { themeFromPreset, ownCustomCss, type ThemePreset } from '~~/shared/utils/themePresets'
import { loadCustomCssSanitizer, currentAppOrigins } from '~/utils/customCssLoader'
import { themeImagesForDoc } from '~~/shared/utils/themeImages'
import { isIsoDate } from '~~/shared/utils/documentLocale'

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
  /**
   * The document's plan includes custom CSS. False → the CSS section
   * shows the plan notice instead of the editor; any stored CSS is kept
   * but not applied. Optional so other callers default to "allowed".
   */
  customCssAllowed?: boolean
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

// Static option lists
const pageSizeItems = [
  { label: 'A4 (210 × 297 mm)', value: 'A4' },
  { label: 'A5 (148 × 210 mm)', value: 'A5' },
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
  { label: t('theme.cover.layoutMinimal'), value: 'minimal' },
  { label: t('theme.cover.layoutTitleBlock'), value: 'title-block' }
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
  const affiliations = draft.value.cover.affiliations
  if (affiliations) draft.value.cover.affiliations = affiliations.filter((_, i) => i !== idx)
}

// Optional theme fields (absent in themes stored before they existed):
// read through their defaults, written only when the user changes them —
// opening the panel must not rewrite the document's theme.
function affiliationAt(idx: number): string {
  return resolveTitleBlock(draft.value).affiliations[idx] ?? ''
}
function setAffiliation(idx: number, value: string | number) {
  const next = [...resolveTitleBlock(draft.value).affiliations]
  while (next.length < draft.value.cover.authors.length) next.push('')
  next[idx] = String(value)
  draft.value.cover.affiliations = next.slice(0, draft.value.cover.authors.length)
}
const coverRules = computed({
  get: () => resolveTitleBlock(draft.value).rules,
  set: (v: boolean) => { draft.value.cover.rules = v }
})
const coverSmallCaps = computed({
  get: () => resolveTitleBlock(draft.value).smallCaps,
  set: (v: boolean) => { draft.value.cover.smallCaps = v }
})
const headingNumberingModel = computed({
  get: () => headingNumbering(draft.value),
  set: (v: HeadingNumbering) => { draft.value.headings.numbering = v }
})
const numberingDepthModel = computed({
  get: () => numberingDepth(draft.value),
  set: (v: NumberingDepth) => { draft.value.headings.numberingDepth = v }
})
const numberingDepthItems = computed<Array<{ label: string, value: NumberingDepth }>>(() => [
  { label: t('theme.headings.numberingDepth1'), value: 1 },
  { label: t('theme.headings.numberingDepthN', { n: 2 }), value: 2 },
  { label: t('theme.headings.numberingDepthN', { n: 3 }), value: 3 },
  { label: t('theme.headings.numberingDepthAll'), value: 4 }
])
const chapterLabelModel = computed({
  get: () => resolveChapterLabel(draft.value).enabled,
  set: (v: boolean) => { draft.value.headings.chapterLabel = v }
})
const chapterWordModel = computed({
  get: () => resolveChapterLabel(draft.value).word,
  // The schema refuses quotes, backslashes, angle brackets and newlines (CSS string).
  set: (v: string) => { draft.value.headings.chapterWord = v.replace(/["\\<>\r\n]/g, '').slice(0, 40) }
})
// Drop cap: a switch (first paragraph) plus "every chapter".
const dropCapOnModel = computed({
  get: () => draft.value.body.dropCap !== false,
  set: (v: boolean) => { draft.value.body.dropCap = v ? (draft.value.body.dropCap || true) : false }
})
const dropCapEveryChapterModel = computed({
  get: () => draft.value.body.dropCap === 'every-chapter',
  set: (v: boolean) => { draft.value.body.dropCap = v ? 'every-chapter' : true }
})
// `{section}` options (header.sectionNumber / sectionMode), shown while a slot uses the token.
const usesSectionToken = computed(() => [draft.value.header, draft.value.footer].some(s => [s.left, s.center, s.right].some(v => v.includes('{section}'))))
const sectionNumberModel = computed({
  get: () => resolveSectionToken(draft.value).number,
  set: (v: boolean) => { draft.value.header.sectionNumber = v }
})
const sectionModeModel = computed({
  get: () => resolveSectionToken(draft.value).mode,
  set: (v: SectionMode) => { draft.value.header.sectionMode = v }
})
const sectionModeItems = computed<Array<{ label: string, value: SectionMode }>>(() => [
  { label: t('theme.runningSlots.sectionModeFirst'), value: 'first' },
  { label: t('theme.runningSlots.sectionModeStart'), value: 'start' }
])
const coverDateFormatModel = computed({
  get: () => coverDateFormat(draft.value),
  set: (v: DateFormat) => { draft.value.cover.dateFormat = v }
})
const coverDateFormatItems = computed<Array<{ label: string, value: DateFormat }>>(() => [
  { label: t('theme.cover.dateFormatLocale'), value: 'locale' },
  { label: t('theme.cover.dateFormatUs'), value: 'us' },
  { label: t('theme.cover.dateFormatIso'), value: 'iso' }
])
const coverRepeatTitleModel = computed({
  get: () => repeatTitle(draft.value),
  set: (v: boolean) => { draft.value.cover.repeatTitle = v }
})
const mirrorMarginsModel = computed({
  get: () => mirrorMargins(draft.value),
  set: (v: boolean) => { draft.value.page.mirrorMargins = v }
})
// Captions + reference list (optional fields, see themeOptions).
const tableCaptionPositionModel = computed({
  get: () => resolveCaptions(draft.value).tablePosition,
  set: (v: CaptionPosition) => { draft.value.tables.captionPosition = v }
})
const tableCaptionLabelModel = computed({
  get: () => resolveCaptions(draft.value).tableLabel,
  set: (v: boolean) => { draft.value.tables.captionLabel = v }
})
const figureLabelModel = computed({
  get: () => resolveCaptions(draft.value).figureLabel,
  set: (v: boolean) => { draft.value.blocks.figureLabel = v }
})
const captionNumberingModel = computed({
  get: () => resolveCaptions(draft.value).numbering,
  set: (v: CaptionNumbering) => { draft.value.blocks.captionNumbering = v }
})
const captionNumberingItems = computed<Array<{ label: string, value: CaptionNumbering }>>(() => [
  { label: t('theme.blocks.captionNumberingDocument'), value: 'document' },
  { label: t('theme.blocks.captionNumberingChapter'), value: 'chapter' }
])
const captionLabelStyleModel = computed({
  get: () => resolveCaptions(draft.value).labelStyle,
  set: (v: CaptionLabelStyle) => { draft.value.blocks.captionLabelStyle = v }
})
const captionLabelStyleItems = computed<Array<{ label: string, value: CaptionLabelStyle }>>(() => [
  { label: t('theme.blocks.captionLabelInline'), value: 'inline' },
  { label: t('theme.blocks.captionLabelStacked'), value: 'stacked' }
])
const referenceStyleModel = computed({
  get: () => referenceStyle(draft.value),
  set: (v: ReferenceStyle) => { draft.value.blocks.referenceStyle = v }
})
const captionPositionItems = computed<Array<{ label: string, value: CaptionPosition }>>(() => [
  { label: t('theme.tables.captionAbove'), value: 'above' },
  { label: t('theme.tables.captionBelow'), value: 'below' }
])
const referenceStyleItems = computed<Array<{ label: string, value: ReferenceStyle }>>(() => [
  { label: t('theme.blocks.referencePlain'), value: 'plain' },
  { label: t('theme.blocks.referenceHanging'), value: 'hanging' },
  { label: t('theme.blocks.referenceBrackets'), value: 'brackets' }
])
// Per-side page margins: each side shows `page.margin` until set; the
// reset button removes all four (back to the uniform margin).
type MarginSide = 'top' | 'right' | 'bottom' | 'left'
const MARGIN_SIDES: readonly MarginSide[] = ['top', 'right', 'bottom', 'left']
const MARGIN_FIELDS = { top: 'marginTop', right: 'marginRight', bottom: 'marginBottom', left: 'marginLeft' } as const
const pageMarginsOpen = ref(MARGIN_SIDES.some(side => draft.value.page[MARGIN_FIELDS[side]] !== undefined))
function onPageMarginsToggle(e: Event) {
  if (e.target instanceof HTMLDetailsElement) pageMarginsOpen.value = e.target.open
}
function pageMargin(side: MarginSide): number {
  return resolvePageMargins(draft.value)[side]
}
function setPageMargin(side: MarginSide, v: number | null | undefined) {
  if (typeof v === 'number') draft.value.page[MARGIN_FIELDS[side]] = v
  else clearSideMargin(side)
}
function clearSideMargin(side: MarginSide) {
  const page = draft.value.page
  if (side === 'top') delete page.marginTop
  else if (side === 'right') delete page.marginRight
  else if (side === 'bottom') delete page.marginBottom
  else delete page.marginLeft
}
const hasSideMargins = computed(() => MARGIN_SIDES.some(side => draft.value.page[MARGIN_FIELDS[side]] !== undefined))
function resetSideMargins() {
  for (const side of MARGIN_SIDES) clearSideMargin(side)
}
const headerRuleModel = computed({
  get: () => runningRule(draft.value.header),
  set: (v: boolean) => { draft.value.header.rule = v }
})
const footerRuleModel = computed({
  get: () => runningRule(draft.value.footer),
  set: (v: boolean) => { draft.value.footer.rule = v }
})
const FONT_WEIGHT_ITEMS = [
  { label: 'Thin (100)', value: 100 },
  { label: 'Extra Light (200)', value: 200 },
  { label: 'Light (300)', value: 300 },
  { label: 'Regular (400)', value: 400 },
  { label: 'Medium (500)', value: 500 },
  { label: 'Semibold (600)', value: 600 },
  { label: 'Bold (700)', value: 700 },
  { label: 'Extra Bold (800)', value: 800 },
  { label: 'Black (900)', value: 900 }
]
/** 0 = "same as the headings" (the field is then absent). */
const coverTitleWeightModel = computed({
  get: () => draft.value.cover.titleWeight ?? 0,
  set: (v: number) => {
    if (v) draft.value.cover.titleWeight = v
    else delete draft.value.cover.titleWeight
  }
})
const coverTitleWeightItems = computed(() => [
  { label: t('theme.cover.titleWeightInherit', { weight: draft.value.headings.weight }), value: 0 },
  ...FONT_WEIGHT_ITEMS
])

// Per-level heading look (headings.levels.h1–h4). Each control shows the
// value in effect (scale / theme-wide weight) and writes only what the
// user changes; "Use defaults" removes the level's overrides again.
const headingLevelsOpen = ref(Boolean(draft.value.headings.levels && Object.keys(draft.value.headings.levels).length))
function onHeadingLevelsToggle(e: Event) {
  if (e.target instanceof HTMLDetailsElement) headingLevelsOpen.value = e.target.open
}
function levelEntry(key: HeadingLevelKey): HeadingLevelStyle | undefined {
  return draft.value.headings.levels?.[key]
}
/** `headings.levels` with level `key` replaced by `entry` (empty levels left out). */
function levelsWith(key: HeadingLevelKey, entry: HeadingLevelStyle | undefined): HeadingLevels {
  const next: HeadingLevels = {}
  for (const k of HEADING_LEVEL_KEYS) {
    const e = k === key ? entry : levelEntry(k)
    if (e && Object.keys(e).length) next[k] = e
  }
  return next
}
function setLevelField<K extends keyof HeadingLevelStyle>(key: HeadingLevelKey, field: K, value: HeadingLevelStyle[K] | undefined) {
  const merged: HeadingLevelStyle = { ...levelEntry(key), [field]: value }
  const entry: HeadingLevelStyle = {}
  if (merged.size !== undefined) entry.size = merged.size
  if (merged.weight !== undefined) entry.weight = merged.weight
  if (merged.style !== undefined) entry.style = merged.style
  if (merged.smallCaps !== undefined) entry.smallCaps = merged.smallCaps
  if (merged.align !== undefined) entry.align = merged.align
  draft.value.headings.levels = levelsWith(key, entry)
}
function levelNumber(key: HeadingLevelKey): number {
  return HEADING_LEVEL_KEYS.indexOf(key) + 1
}
/** Size × body in effect: the override, else the scale's value for this level. */
function levelSize(key: HeadingLevelKey): number {
  const override = levelEntry(key)?.size
  if (override !== undefined) return override
  const exp = HEADING_SCALE_EXPONENTS[levelNumber(key) - 1] ?? 0
  return Math.round(Math.pow(draft.value.headings.scale, exp) * 100) / 100
}
function setLevelSize(key: HeadingLevelKey, v: number | null | undefined) {
  setLevelField(key, 'size', typeof v === 'number' ? v : undefined)
}
function levelWeight(key: HeadingLevelKey): number {
  return resolveHeadingLevel(draft.value, levelNumber(key)).weight
}
function setLevelWeight(key: HeadingLevelKey, v: number) {
  setLevelField(key, 'weight', v)
}
function levelItalic(key: HeadingLevelKey): boolean {
  return resolveHeadingLevel(draft.value, levelNumber(key)).style === 'italic'
}
function setLevelItalic(key: HeadingLevelKey, v: boolean) {
  const style: HeadingStyle = v ? 'italic' : 'normal'
  setLevelField(key, 'style', style)
}
function levelCentered(key: HeadingLevelKey): boolean {
  return resolveHeadingLevel(draft.value, levelNumber(key)).align === 'center'
}
function setLevelCentered(key: HeadingLevelKey, v: boolean) {
  setLevelField(key, 'align', v ? 'center' : undefined)
}
function levelSmallCaps(key: HeadingLevelKey): boolean {
  return resolveHeadingLevel(draft.value, levelNumber(key)).smallCaps
}
function setLevelSmallCaps(key: HeadingLevelKey, v: boolean) {
  setLevelField(key, 'smallCaps', v)
}
function levelHasOverrides(key: HeadingLevelKey): boolean {
  return Object.keys(levelEntry(key) ?? {}).length > 0
}
function resetLevel(key: HeadingLevelKey) {
  draft.value.headings.levels = levelsWith(key, undefined)
}

const headingNumberingItems = computed<Array<{ label: string, value: HeadingNumbering }>>(() => [
  { label: t('theme.headings.numberingNone'), value: 'none' },
  { label: t('theme.headings.numberingDecimal'), value: 'decimal' },
  { label: t('theme.headings.numberingDecimalDot'), value: 'decimal-dot' },
  { label: t('theme.headings.numberingIeee'), value: 'ieee' },
  { label: t('theme.headings.numberingDecimalZero'), value: 'decimal-zero' }
])
/**
 * SYSTEM_CODE_FONT stands for "system monospace" in the picker (the field
 * is then absent). Not '': Reka's SelectItem refuses an empty value.
 */
const SYSTEM_CODE_FONT = 'system-monospace'
const codeFontModel = computed({
  get: () => draft.value.code.font ?? SYSTEM_CODE_FONT,
  set: (v: string) => {
    if (v && v !== SYSTEM_CODE_FONT) draft.value.code.font = v
    else delete draft.value.code.font
  }
})
const codeFontItems = computed(() => [
  { label: t('theme.code.fontSystem'), value: SYSTEM_CODE_FONT },
  ...CODE_FONT_NAMES.map(name => ({ label: name, value: name }))
])
const codeBackgroundModel = computed({
  get: () => draft.value.code.background ?? CODE_OPTION_DEFAULTS.background,
  set: (v: CodeBackground) => { draft.value.code.background = v }
})
const codeBackgroundItems = computed<Array<{ label: string, value: CodeBackground }>>(() => [
  { label: t('theme.code.backgroundAuto'), value: 'auto' },
  { label: t('theme.code.backgroundTint'), value: 'tint' },
  { label: t('theme.code.backgroundNone'), value: 'none' }
])
const codeFrameModel = computed({
  get: () => draft.value.code.frame ?? CODE_OPTION_DEFAULTS.frame,
  set: (v: CodeFrame) => { draft.value.code.frame = v }
})
const codeFrameItems = computed<Array<{ label: string, value: CodeFrame }>>(() => [
  { label: t('theme.code.frameNone'), value: 'none' },
  { label: t('theme.code.frameRule'), value: 'rule' },
  { label: t('theme.code.frameBox'), value: 'box' }
])
const codeWrapModel = computed({
  get: () => draft.value.code.wrap ?? CODE_OPTION_DEFAULTS.wrap,
  set: (v: boolean) => { draft.value.code.wrap = v }
})
const codeLineNumbersModel = computed({
  get: () => draft.value.code.lineNumbers ?? CODE_OPTION_DEFAULTS.lineNumbers,
  set: (v: boolean) => { draft.value.code.lineNumbers = v }
})

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
// h1 = body × scale³ (themeToCss HEADING_SCALE_EXPONENTS); the label
// says what that means on the page. A stored value outside the list is
// added so the select never shows blank.
const HEADING_SCALES = [1.12, 1.15, 1.18, 1.2, 1.22, 1.25, 1.28, 1.333, 1.414]
const headingScaleItems = computed(() => {
  const values = HEADING_SCALES.includes(draft.value.headings.scale)
    ? HEADING_SCALES
    : [...HEADING_SCALES, draft.value.headings.scale].sort((a, b) => a - b)
  return values.map(value => ({
    label: t('theme.headings.scaleOption', { ratio: value.toFixed(3).replace(/0$/, ''), h1: Math.pow(value, 3).toFixed(1) }),
    value
  }))
})
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
const mermaidThemeItems = computed<Array<{ label: string, value: MermaidTheme }>>(() => [
  { label: t('theme.mermaid.themeDocument'), value: 'document' },
  { label: t('theme.mermaid.themeDefault'), value: 'default' },
  { label: t('theme.mermaid.themeDark'), value: 'dark' },
  { label: t('theme.mermaid.themeForest'), value: 'forest' },
  { label: t('theme.mermaid.themeNeutral'), value: 'neutral' },
  { label: t('theme.mermaid.themeBase'), value: 'base' }
])

// Cover publication date (`YYYY-MM-DD`, '' = the render date). A native
// date input already speaks that format.
const coverDate = computed({
  get: () => draft.value.cover.date ?? '',
  set: (v: string) => {
    draft.value.cover.date = isIsoDate(v) ? v : ''
  }
})

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
  { token: '{section}' },
  { token: '{author}' },
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

// ─── User-saved themes ────────────────────────────────────────────
//
// Anonymous viewers see no saved-themes UI (server returns 401, list
// stays empty). Logged-in users get a "Your themes" section ABOVE the
// built-in presets and a "Save current theme" button beside the
// section eyebrow. Same one-click apply, plus rename + delete.

interface SavedTheme {
  themeId: string
  name: string
  description?: string
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

async function onThemeDialogSaved(name: string) {
  await refreshSavedThemes()
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

async function onDesignImportSaved(name: string) {
  await refreshSavedThemes()
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
            <!-- Same card as the built-in presets below (name in the
                 theme's heading face, one description line) plus two
                 neutral icon actions. The trash stays sumi; the error
                 colour only appears in the confirmation dialog. -->
            <div
              v-for="saved in savedThemes"
              :key="saved.themeId"
              :data-testid="`theme-saved-${saved.themeId}`"
              class="relative rounded-md border border-default bg-default hover:border-default/80 hover:bg-default/80 transition-colors"
            >
              <button
                type="button"
                class="block w-full text-left p-3 pr-18 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                :data-testid="`saved-theme-apply-${saved.themeId}`"
                @click="applySaved(saved)"
              >
                <div class="flex items-center gap-2 mb-1">
                  <span
                    class="size-3 rounded-full shrink-0"
                    :style="{ backgroundColor: saved.theme.color.brand }"
                  />
                  <span
                    class="text-sm font-medium truncate"
                    :style="{ fontFamily: `'${saved.theme.headings.font}', system-ui, sans-serif` }"
                  >
                    {{ saved.name }}
                  </span>
                </div>
                <p
                  class="text-xs text-muted leading-snug line-clamp-2"
                  :data-testid="`saved-theme-description-${saved.themeId}`"
                >
                  {{ saved.description || t('theme.saved.fallbackDescription', { heading: saved.theme.headings.font, body: saved.theme.body.font }) }}
                </p>
              </button>
              <div class="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                <UTooltip :text="t('theme.saved.edit')">
                  <UButton
                    :aria-label="t('theme.saved.editAria', { name: saved.name })"
                    icon="i-lucide-pencil"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    class="text-muted hover:text-default"
                    :data-testid="`saved-theme-edit-${saved.themeId}`"
                    @click.stop="editSaved(saved)"
                  />
                </UTooltip>
                <UTooltip :text="t('theme.saved.delete')">
                  <UButton
                    :aria-label="t('theme.saved.deleteAria', { name: saved.name })"
                    icon="i-lucide-trash-2"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    class="text-muted hover:text-default"
                    :data-testid="`saved-theme-delete-${saved.themeId}`"
                    @click.stop="deleteSaved(saved)"
                  />
                </UTooltip>
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
                <UFormField
                  v-if="draft.cover.layout === 'title-block'"
                  :label="t('theme.cover.rules')"
                  :help="t('theme.cover.rulesHelp')"
                >
                  <USwitch v-model="coverRules" />
                </UFormField>
                <UFormField :label="t('theme.cover.smallCaps')">
                  <USwitch v-model="coverSmallCaps" />
                </UFormField>
                <UFormField :label="t('theme.cover.titleWeight')">
                  <USelect
                    v-model="coverTitleWeightModel"
                    :items="coverTitleWeightItems"
                    class="w-full"
                    data-testid="theme-cover-title-weight"
                  />
                </UFormField>
                <p
                  v-if="draft.cover.layout === 'title-block'"
                  class="text-xs text-muted"
                >
                  {{ t('theme.cover.titleBlockHelp') }}
                </p>
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
                <UFormField
                  :label="t('theme.cover.date')"
                  :help="t('theme.cover.dateHelp')"
                >
                  <div class="flex items-center gap-2">
                    <UInput
                      v-model="coverDate"
                      type="date"
                      class="flex-1"
                      data-testid="theme-cover-date-input"
                    />
                    <UButton
                      v-if="coverDate"
                      icon="i-lucide-x"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      :aria-label="t('theme.cover.dateClear')"
                      @click="coverDate = ''"
                    />
                  </div>
                </UFormField>
                <UFormField :label="t('theme.cover.dateFormat')">
                  <USelect
                    v-model="coverDateFormatModel"
                    :items="coverDateFormatItems"
                    class="w-full"
                    data-testid="theme-cover-date-format"
                  />
                </UFormField>
                <UFormField
                  :label="t('theme.cover.repeatTitle')"
                  :help="t('theme.cover.repeatTitleHelp')"
                >
                  <USwitch
                    v-model="coverRepeatTitleModel"
                    data-testid="theme-cover-repeat-title"
                  />
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
                      <div class="flex-1 space-y-1">
                        <UInput
                          v-model="draft.cover.authors[idx]"
                          :placeholder="t('theme.cover.authorPlaceholder')"
                          maxlength="100"
                          class="w-full"
                        />
                        <UTextarea
                          :model-value="affiliationAt(idx)"
                          :placeholder="t('theme.cover.affiliationPlaceholder')"
                          :rows="2"
                          autoresize
                          maxlength="300"
                          class="w-full"
                          :data-testid="`theme-cover-affiliation-${idx}`"
                          @update:model-value="setAffiliation(idx, $event)"
                        />
                      </div>
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
              <!-- Per-side margins (page.marginTop/Right/Bottom/Left):
                   collapsed unless the theme already sets one. -->
              <details
                class="rounded-md border border-default"
                data-testid="theme-page-margins"
                :open="pageMarginsOpen"
                @toggle="onPageMarginsToggle"
              >
                <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                  {{ t('theme.page.sideMargins') }}
                </summary>
                <div class="space-y-3 px-3 pb-3">
                  <p class="text-xs text-muted">
                    {{ t('theme.page.sideMarginsHelp') }}
                  </p>
                  <div class="grid grid-cols-2 gap-2">
                    <UFormField
                      v-for="side in MARGIN_SIDES"
                      :key="side"
                      :label="t(`theme.page.margin_${side}`)"
                    >
                      <UInputNumber
                        :model-value="pageMargin(side)"
                        :min="0"
                        :max="60"
                        :step="1"
                        class="w-full"
                        :data-testid="`theme-page-margin-${side}`"
                        @update:model-value="(v: number | null | undefined) => setPageMargin(side, v)"
                      />
                    </UFormField>
                  </div>
                  <UButton
                    v-if="hasSideMargins"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    data-testid="theme-page-margins-reset"
                    @click="resetSideMargins"
                  >
                    {{ t('theme.page.sideMarginsReset') }}
                  </UButton>
                  <UFormField
                    :label="t('theme.page.mirrorMargins')"
                    :help="t('theme.page.mirrorMarginsHelp')"
                  >
                    <USwitch
                      v-model="mirrorMarginsModel"
                      data-testid="theme-page-mirror-margins"
                    />
                  </UFormField>
                </div>
              </details>
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
                  v-model="dropCapOnModel"
                  data-testid="theme-body-drop-cap-switch"
                />
              </UFormField>
              <UFormField
                v-if="dropCapOnModel"
                :label="t('theme.body.dropCapEveryChapter')"
                :help="t('theme.body.dropCapEveryChapterHelp')"
              >
                <USwitch
                  v-model="dropCapEveryChapterModel"
                  data-testid="theme-body-drop-cap-every-chapter"
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
              <UFormField
                :label="t('theme.headings.numbering')"
                :help="t('theme.headings.numberingHelp', { code: '{.unnumbered}' })"
              >
                <USelect
                  v-model="headingNumberingModel"
                  :items="headingNumberingItems"
                  class="w-full"
                  data-testid="theme-headings-numbering"
                />
              </UFormField>
              <template v-if="headingNumberingModel !== 'none'">
                <UFormField :label="t('theme.headings.numberingDepth')">
                  <USelect
                    v-model="numberingDepthModel"
                    :items="numberingDepthItems"
                    class="w-full"
                    data-testid="theme-headings-numbering-depth"
                  />
                </UFormField>
                <UFormField
                  :label="t('theme.headings.chapterLabel')"
                  :help="t('theme.headings.chapterLabelHelp')"
                >
                  <USwitch
                    v-model="chapterLabelModel"
                    data-testid="theme-headings-chapter-label"
                  />
                </UFormField>
                <UFormField
                  v-if="chapterLabelModel"
                  :label="t('theme.headings.chapterWord')"
                  :help="t('theme.headings.chapterWordHelp')"
                >
                  <UInput
                    v-model="chapterWordModel"
                    maxlength="40"
                    :placeholder="t('theme.headings.chapterWordPlaceholder')"
                    class="w-full"
                    data-testid="theme-headings-chapter-word"
                  />
                </UFormField>
              </template>
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
              <!-- Per-level look (headings.levels): collapsed unless the
                   theme already overrides a level. -->
              <details
                class="rounded-md border border-default"
                data-testid="theme-heading-levels"
                :open="headingLevelsOpen"
                @toggle="onHeadingLevelsToggle"
              >
                <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                  {{ t('theme.headings.levels') }}
                </summary>
                <div class="space-y-4 px-3 pb-3">
                  <p class="text-xs text-muted">
                    {{ t('theme.headings.levelsHelp') }}
                  </p>
                  <div
                    v-for="key in HEADING_LEVEL_KEYS"
                    :key="key"
                    class="space-y-2"
                    :data-testid="`theme-heading-level-${key}`"
                  >
                    <div class="flex items-center justify-between">
                      <span class="text-sm font-medium">{{ t('theme.headings.levelTitle', { level: levelNumber(key) }) }}</span>
                      <UButton
                        v-if="levelHasOverrides(key)"
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        :data-testid="`theme-heading-level-${key}-reset`"
                        @click="resetLevel(key)"
                      >
                        {{ t('theme.headings.levelReset') }}
                      </UButton>
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                      <UFormField :label="t('theme.headings.levelSize')">
                        <UInputNumber
                          :model-value="levelSize(key)"
                          :min="0.5"
                          :max="4"
                          :step="0.05"
                          class="w-full"
                          :data-testid="`theme-heading-level-${key}-size`"
                          @update:model-value="(v: number | null | undefined) => setLevelSize(key, v)"
                        />
                      </UFormField>
                      <UFormField :label="t('theme.headings.weight')">
                        <USelect
                          :model-value="levelWeight(key)"
                          :items="FONT_WEIGHT_ITEMS"
                          class="w-full"
                          @update:model-value="(v: number) => setLevelWeight(key, v)"
                        />
                      </UFormField>
                    </div>
                    <div class="flex flex-wrap gap-x-6 gap-y-2">
                      <USwitch
                        :model-value="levelItalic(key)"
                        :label="t('theme.headings.levelItalic')"
                        @update:model-value="(v: boolean) => setLevelItalic(key, v)"
                      />
                      <USwitch
                        :model-value="levelSmallCaps(key)"
                        :label="t('theme.headings.levelSmallCaps')"
                        @update:model-value="(v: boolean) => setLevelSmallCaps(key, v)"
                      />
                      <USwitch
                        :model-value="levelCentered(key)"
                        :label="t('theme.headings.levelCentered')"
                        :data-testid="`theme-heading-level-${key}-centered`"
                        @update:model-value="(v: boolean) => setLevelCentered(key, v)"
                      />
                    </div>
                  </div>
                </div>
              </details>
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
              <UFormField
                :label="t('theme.runningSlots.ruleHeader')"
                :help="t('theme.runningSlots.ruleHelp')"
              >
                <USwitch
                  v-model="headerRuleModel"
                  data-testid="theme-header-rule"
                />
              </UFormField>
              <template v-if="usesSectionToken">
                <UFormField
                  :label="t('theme.runningSlots.sectionNumber', { token: '{section}' })"
                  :help="t('theme.runningSlots.sectionNumberHelp')"
                >
                  <USwitch
                    v-model="sectionNumberModel"
                    data-testid="theme-header-section-number"
                  />
                </UFormField>
                <UFormField
                  :label="t('theme.runningSlots.sectionMode', { token: '{section}' })"
                  :help="t('theme.runningSlots.sectionModeHelp')"
                >
                  <USelect
                    v-model="sectionModeModel"
                    :items="sectionModeItems"
                    class="w-full"
                    data-testid="theme-header-section-mode"
                  />
                </UFormField>
              </template>

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
              <UFormField
                :label="t('theme.runningSlots.ruleFooter')"
                :help="t('theme.runningSlots.ruleHelp')"
              >
                <USwitch
                  v-model="footerRuleModel"
                  data-testid="theme-footer-rule"
                />
              </UFormField>
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
              <UFormField :label="t('theme.code.font')">
                <USelect
                  v-model="codeFontModel"
                  :items="codeFontItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                :label="t('theme.code.background')"
                :help="t('theme.code.backgroundHelp')"
              >
                <USelect
                  v-model="codeBackgroundModel"
                  :items="codeBackgroundItems"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('theme.code.frame')">
                <USelect
                  v-model="codeFrameModel"
                  :items="codeFrameItems"
                  class="w-full"
                  data-testid="theme-code-frame"
                />
              </UFormField>
              <UFormField
                :label="t('theme.code.wrap')"
                :help="t('theme.code.wrapHelp')"
              >
                <USwitch v-model="codeWrapModel" />
              </UFormField>
              <UFormField :label="t('theme.code.lineNumbers')">
                <USwitch v-model="codeLineNumbersModel" />
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
              <UFormField
                :label="t('theme.tables.captionPosition')"
                :help="t('theme.tables.captionPositionHelp', { code: 'Table: …' })"
              >
                <USelect
                  v-model="tableCaptionPositionModel"
                  :items="captionPositionItems"
                  class="w-full"
                  data-testid="theme-tables-caption-position"
                />
              </UFormField>
              <UFormField
                :label="t('theme.tables.captionLabel')"
                :help="t('theme.tables.captionLabelHelp')"
              >
                <USwitch
                  v-model="tableCaptionLabelModel"
                  data-testid="theme-tables-caption-label"
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
              <UFormField
                :label="t('theme.blocks.figureLabel')"
                :help="t('theme.blocks.figureLabelHelp')"
              >
                <USwitch
                  v-model="figureLabelModel"
                  data-testid="theme-blocks-figure-label"
                />
              </UFormField>
              <template v-if="figureLabelModel || tableCaptionLabelModel">
                <UFormField
                  :label="t('theme.blocks.captionNumbering')"
                  :help="t('theme.blocks.captionNumberingHelp')"
                >
                  <USelect
                    v-model="captionNumberingModel"
                    :items="captionNumberingItems"
                    class="w-full"
                    data-testid="theme-blocks-caption-numbering"
                  />
                </UFormField>
                <UFormField :label="t('theme.blocks.captionLabelStyle')">
                  <USelect
                    v-model="captionLabelStyleModel"
                    :items="captionLabelStyleItems"
                    class="w-full"
                    data-testid="theme-blocks-caption-label-style"
                  />
                </UFormField>
              </template>
              <UFormField
                :label="t('theme.blocks.referenceStyle')"
                :help="t('theme.blocks.referenceStyleHelp')"
              >
                <USelect
                  v-model="referenceStyleModel"
                  :items="referenceStyleItems"
                  class="w-full"
                  data-testid="theme-blocks-reference-style"
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
      @deleted="refreshSavedThemes"
    />
  </div>
</template>
