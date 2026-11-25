<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import type { TabName } from './tabBarTypes'
import { SOURCE_REPO_NEW_ISSUE_URL, SOURCE_REPO_URL } from '~~/shared/config/links'
import {
  toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList, toggleCode, toggleComment,
  insertBlock, insertFootnote, insertAlert, insertMath, insertDiagram,
  insertToc, insertPageBreak, insertDefinitionList, insertListPlaceholder
} from '~/utils/editor/editorCommands'

/**
 * Google-Docs-style top menu bar. The formatting toolbar, view-mode toggles
 * and sidebar toggles keep their header shortcuts; the menu items duplicate
 * them for discoverability and aren't the only entry point.
 */

const props = defineProps<{
  view: EditorView | null
  docId: string
  isReadOnly: boolean
  loggedIn: boolean
  // Owner or workspace admin: gates the destructive / ownership-changing File entries (Move, Delete).
  canManage: boolean
  // Server-computed (token endpoint): owner / workspace admin, or the
  // browser that created an anonymous doc.
  canDelete: boolean
  // Right-sidebar state: renders check marks next to "Activity" and "Theme" in the View menu.
  rightSidebar: TabName | null
  // Only workspace members get a meaningful Knowledge panel; gates the menu
  // entry so non-workspace docs don't show a disabled item.
  hasKnowledgeAccess: boolean
  viewMode: 'edit' | 'split' | 'preview'
  /** Live-dictation state, so the Insert menu can flip its label and show a check while active. */
  dictationState?: 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'finishing' | 'error'
  /** Share-link controls: the owner made this a view-only link, so no export or print. */
  noDownload?: boolean
  /** The left panel (outline, workspace documents) is open: its check mark in the View menu. */
  leftPanelOpen?: boolean
}>()

const dictationMenuLabel = computed(() => {
  if (props.dictationState === 'finishing') return t('ai.dictateFinishing')
  return props.dictationState === 'recording' || props.dictationState === 'connecting'
    ? t('ai.dictateStop')
    : t('ai.dictateStart')
})

const emit = defineEmits<{
  'open-import': []
  'open-share': []
  'open-share-password': []
  'export-markdown': []
  'export-pdf': []
  // Server-rendered PDF (Playwright + paged.js) opens in a new tab via
  // /api/docs/:id/pdf; distinct from `export-pdf` (in-tab print dialog).
  'open-server-pdf': []
  'new-document': []
  'duplicate-document': []
  'move-document': []
  'delete-document': []
  'set-view-mode': ['edit' | 'split' | 'preview']
  'toggle-sidebar': ['document' | 'activity' | 'theme' | 'knowledge' | 'comments' | 'references']
  'toggle-left-panel': []
  'undo': []
  'redo': []
  'open-image-picker': []
  // Handed up to EditorLayout, which owns the shared open state; the toolbar's anchored UPopover is the one visual surface.
  'open-table-picker': []
  // Hoisted to the parent, where the composable owns the editor + ydoc + awareness wiring.
  'toggle-dictation': []
  // Insert → Comment: the parent captures the selection, opens the sidebar, focuses the composer.
  'create-comment': []
  'open-docs': []
  'open-shortcuts': []
  'start-tour': []
  // Format / insert dispatch on the editor view through callbacks instead of
  // emits, so commands needn't be re-threaded through EditorLayout.
}>()

const { t, locale, locales, setLocale } = useI18n()
// Defer the color-mode read to onMounted: useColorMode() returns 'light' on
// SSR, so a top-level read mismatches on hydration for dark-mode users (see
// app/AGENTS.md "Common Vue conventions").
const colorMode = useColorMode()
const colorModeValue = ref<'light' | 'dark'>('light')
onMounted(() => {
  colorModeValue.value = colorMode.value === 'dark' ? 'dark' : 'light'
})
watch(() => colorMode.value, (v) => {
  colorModeValue.value = v === 'dark' ? 'dark' : 'light'
})
// Sharing → Copy link. `useClipboard` (inside) adds an execCommand fallback for
// iframe / older-browser contexts the Async Clipboard API doesn't reach.
const { copy: copyToClipboard } = useCopyText()

// Delegates to shared utils so menu and toolbar produce identical output
// (smart toggle, whitespace trim, prefix replacement); see `app/utils/editor/editorCommands.ts`.

function call(fn: (v: EditorView) => void) {
  if (!props.view || props.isReadOnly) return
  fn(props.view)
}

// Nuxt UI v4 UDropdownMenu items: label, icon, kbds, onSelect, disabled,
// type ('separator'|'label'), children (submenu), checked.

const fileItems = computed(() => {
  const items: Array<Record<string, unknown>> = [
    { label: t('menubar.file.new'), icon: 'i-lucide-file-plus', onSelect: () => emit('new-document') }
  ]
  if (!props.isReadOnly) {
    items.push({ label: t('menubar.file.import'), icon: 'i-lucide-file-up', onSelect: () => emit('open-import') })
  }
  if (!props.noDownload) items.push(
    {
      label: t('menubar.file.export'),
      icon: 'i-lucide-download',
      children: [
        { label: t('export.markdown'), icon: 'i-lucide-file-text', onSelect: () => emit('export-markdown') },
        // Server renderer (Playwright + paged.js), opened inline in a new tab;
        // File → Print uses the in-browser print dialog instead.
        { label: t('export.pdf'), icon: 'i-lucide-file-output', onSelect: () => emit('open-server-pdf') }
      ]
    },
    { type: 'separator' },
    { label: t('menubar.file.print'), icon: 'i-lucide-printer', kbds: ['meta', 'p'], onSelect: () => emit('export-pdf') }
  )
  // Duplicate is open to anyone who can edit (the server re-checks); Move needs
  // manage rights. Both need login: the server rejects anonymous because they need an owner.
  if (props.loggedIn) {
    items.push(
      { type: 'separator' },
      { label: t('menubar.file.duplicate'), icon: 'i-lucide-copy', onSelect: () => emit('duplicate-document') }
    )
    if (props.canManage) {
      items.push({ label: t('menubar.file.move'), icon: 'i-lucide-folder-input', onSelect: () => emit('move-document') })
    }
  }
  // Delete sits under its own separator so it isn't a one-click slip from
  // copy/move. Shown only when the server says it would succeed (an anonymous
  // creator has no login but may delete their own doc).
  if (props.canDelete) {
    items.push(
      { type: 'separator' },
      { label: t('menubar.file.delete'), icon: 'i-lucide-trash-2', onSelect: () => emit('delete-document') }
    )
  }
  return [items]
})

const editItems = computed(() => {
  const items: Array<Record<string, unknown>> = [
    { label: t('menubar.edit.undo'), icon: 'i-lucide-undo-2', kbds: ['meta', 'z'], disabled: props.isReadOnly, onSelect: () => emit('undo') },
    { label: t('menubar.edit.redo'), icon: 'i-lucide-redo-2', kbds: ['meta', 'shift', 'z'], disabled: props.isReadOnly, onSelect: () => emit('redo') }
  ]
  return [items]
})

const zoomMenu = usePreviewZoomMenu({ withStepItems: true })

const viewItems = computed(() => [
  [
    {
      label: t('editor.edit'),
      icon: 'i-lucide-code-2',
      type: 'checkbox' as const,
      checked: props.viewMode === 'edit',
      onSelect: () => emit('set-view-mode', 'edit')
    },
    {
      label: t('editor.splitView'),
      icon: 'i-lucide-columns-2',
      type: 'checkbox' as const,
      checked: props.viewMode === 'split',
      onSelect: () => emit('set-view-mode', 'split')
    },
    {
      label: t('editor.preview'),
      icon: 'i-lucide-eye',
      type: 'checkbox' as const,
      checked: props.viewMode === 'preview',
      onSelect: () => emit('set-view-mode', 'preview')
    },
    // Only while a preview is on screen.
    {
      label: t('previewZoom.menu'),
      icon: 'i-lucide-zoom-in',
      disabled: props.viewMode === 'edit',
      children: zoomMenu.items.value
    }
  ],
  // Independent toggles, though the parent keeps them mutually exclusive; the check marks the active one.
  [
    // The left panel, on its own beside the right-hand ones.
    {
      label: t('leftPanel.label'),
      icon: 'i-lucide-panel-left',
      type: 'checkbox' as const,
      checked: props.leftPanelOpen === true,
      kbds: ['meta', 'shift', 'e'],
      onSelect: () => emit('toggle-left-panel')
    },
    {
      label: t('documentPanel.title'),
      icon: 'i-lucide-info',
      type: 'checkbox' as const,
      checked: props.rightSidebar === 'document',
      onSelect: () => emit('toggle-sidebar', 'document')
    },
    {
      label: t('comments.title'),
      icon: 'i-lucide-message-circle',
      type: 'checkbox' as const,
      checked: props.rightSidebar === 'comments',
      onSelect: () => emit('toggle-sidebar', 'comments')
    },
    {
      label: t('activity.title'),
      icon: 'i-lucide-activity',
      type: 'checkbox' as const,
      checked: props.rightSidebar === 'activity',
      onSelect: () => emit('toggle-sidebar', 'activity')
    },
    {
      label: t('theme.title'),
      icon: 'i-lucide-palette',
      type: 'checkbox' as const,
      checked: props.rightSidebar === 'theme',
      onSelect: () => emit('toggle-sidebar', 'theme')
    },
    {
      label: t('references.title'),
      icon: 'i-lucide-book-marked',
      type: 'checkbox' as const,
      checked: props.rightSidebar === 'references',
      onSelect: () => emit('toggle-sidebar', 'references')
    },
    // Workspace docs only, so the menu doesn't advertise an unavailable capability.
    ...(props.hasKnowledgeAccess
      ? [{
          label: t('knowledge.title'),
          icon: 'i-lucide-library',
          type: 'checkbox' as const,
          checked: props.rightSidebar === 'knowledge',
          onSelect: () => emit('toggle-sidebar', 'knowledge')
        }]
      : [])
  ],
  [
    {
      label: colorModeValue.value === 'dark' ? t('menu.lightMode') : t('menu.darkMode'),
      icon: colorModeValue.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
      onSelect: () => { colorMode.preference = colorModeValue.value === 'dark' ? 'light' : 'dark' }
    },
    {
      label: t('menubar.view.language'),
      icon: 'i-lucide-languages',
      children: (locales.value as Array<{ code: string, name: string }>).map(l => ({
        label: l.name,
        type: 'checkbox' as const,
        checked: locale.value === l.code,
        onSelect: () => setLocale(l.code as 'en' | 'de' | 'fr' | 'es' | 'ja' | 'zh')
      }))
    }
  ]
])

// Link is asymmetric (URL placeholder), so it can't use the symmetric-wrap helper.
function linkAction() {
  if (!props.view || props.isReadOnly) return
  const v = props.view
  const { from, to } = v.state.selection.main
  const selected = v.state.sliceDoc(from, to) || 'text'
  v.dispatch({
    changes: { from, to, insert: `[${selected}](url)` },
    selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 }
  })
  v.focus()
}

// Insert → Generate image with AI. The dialog is mounted here (always, also
// on mobile where the bar is hidden) and opened from the mobile Editor panel too.
const { request: requestGenerateImage, imageLocked } = useGenerateImageDialog()
const insertItems = computed(() => {
  if (props.isReadOnly) return [[]]
  return [[
    { label: t('editor.image'), icon: 'i-lucide-image', onSelect: () => emit('open-image-picker') },
    ...(props.loggedIn ? [{ label: t('aiImage.menu'), icon: imageLocked.value ? 'i-lucide-lock' : 'i-lucide-image-plus', onSelect: requestGenerateImage }] : []),
    { label: t('editor.link'), icon: 'i-lucide-link', onSelect: linkAction },
    {
      label: t('editor.heading'),
      icon: 'i-lucide-heading',
      children: [
        { label: 'H1', icon: 'i-lucide-heading-1', onSelect: () => call(v => toggleHeading(v, 1)) },
        { label: 'H2', icon: 'i-lucide-heading-2', onSelect: () => call(v => toggleHeading(v, 2)) },
        { label: 'H3', icon: 'i-lucide-heading-3', onSelect: () => call(v => toggleHeading(v, 3)) }
      ]
    },
    { type: 'separator' as const },
    { label: t('menubar.insert.codeBlock'), icon: 'i-lucide-code', onSelect: () => call(v => insertBlock(v, '\n```\n\n```\n')) },
    { label: t('editor.quote'), icon: 'i-lucide-quote', onSelect: () => call(v => toggleLinePrefix(v, '> ')) },
    // Opens the toolbar Table button's hover-grid picker; EditorLayout owns the open state.
    { label: t('editor.table'), icon: 'i-lucide-table', onSelect: () => emit('open-table-picker') },
    { label: t('editor.horizontalRule'), icon: 'i-lucide-minus', onSelect: () => call(v => insertBlock(v, '\n---\n')) },
    { label: t('editor.pageBreak'), icon: 'i-lucide-scissors-line-dashed', onSelect: () => call(v => insertPageBreak(v)) },
    { label: t('editor.hideFromPreview'), icon: 'i-lucide-eye-off', onSelect: () => call(v => toggleComment(v)) },
    // Discussion comment: opens a sidebar thread with replies + resolve, unlike
    // the markdown comment above, which stays in the source (hidden from preview).
    { label: t('comments.title'), icon: 'i-lucide-message-circle', onSelect: () => emit('create-comment') },
    { type: 'separator' as const },
    { label: t('menubar.insert.footnote'), icon: 'i-lucide-asterisk', onSelect: () => call(v => insertFootnote(v)) },
    {
      label: t('menubar.insert.alert'),
      icon: 'i-lucide-message-square-warning',
      children: [
        { label: t('menubar.insert.alertNote'), icon: 'i-lucide-info', onSelect: () => call(v => insertAlert(v, 'NOTE')) },
        { label: t('menubar.insert.alertTip'), icon: 'i-lucide-lightbulb', onSelect: () => call(v => insertAlert(v, 'TIP')) },
        { label: t('menubar.insert.alertImportant'), icon: 'i-lucide-megaphone', onSelect: () => call(v => insertAlert(v, 'IMPORTANT')) },
        { label: t('menubar.insert.alertWarning'), icon: 'i-lucide-alert-triangle', onSelect: () => call(v => insertAlert(v, 'WARNING')) },
        { label: t('menubar.insert.alertCaution'), icon: 'i-lucide-octagon-alert', onSelect: () => call(v => insertAlert(v, 'CAUTION')) }
      ]
    },
    {
      label: t('menubar.insert.math'),
      icon: 'i-lucide-sigma',
      children: [
        { label: t('menubar.insert.mathInline'), icon: 'i-lucide-pi', onSelect: () => call(v => insertMath(v, 'inline')) },
        { label: t('menubar.insert.mathBlock'), icon: 'i-lucide-square-sigma', onSelect: () => call(v => insertMath(v, 'block')) }
      ]
    },
    {
      label: t('menubar.insert.diagram'),
      icon: 'i-lucide-workflow',
      children: [
        { label: t('menubar.insert.diagramFlowchart'), icon: 'i-lucide-git-fork', onSelect: () => call(v => insertDiagram(v, 'flowchart')) },
        { label: t('menubar.insert.diagramSequence'), icon: 'i-lucide-arrow-left-right', onSelect: () => call(v => insertDiagram(v, 'sequence')) },
        { label: t('menubar.insert.diagramClass'), icon: 'i-lucide-box', onSelect: () => call(v => insertDiagram(v, 'class')) },
        { label: t('menubar.insert.diagramState'), icon: 'i-lucide-activity', onSelect: () => call(v => insertDiagram(v, 'state')) },
        { label: t('menubar.insert.diagramEr'), icon: 'i-lucide-database', onSelect: () => call(v => insertDiagram(v, 'er')) },
        { label: t('menubar.insert.diagramGantt'), icon: 'i-lucide-bar-chart-3', onSelect: () => call(v => insertDiagram(v, 'gantt')) },
        { label: t('menubar.insert.diagramPie'), icon: 'i-lucide-pie-chart', onSelect: () => call(v => insertDiagram(v, 'pie')) },
        { label: t('menubar.insert.diagramMindmap'), icon: 'i-lucide-network', onSelect: () => call(v => insertDiagram(v, 'mindmap')) }
      ]
    },
    { label: t('menubar.insert.toc'), icon: 'i-lucide-list-tree', onSelect: () => call(v => insertToc(v)) },
    {
      label: t('menubar.insert.references'),
      icon: 'i-lucide-book-marked',
      children: [
        { label: t('menubar.insert.citation'), icon: 'i-lucide-quote', onSelect: () => emit('toggle-sidebar', 'references') },
        { label: t('menubar.insert.bibliography'), icon: 'i-lucide-library-big', onSelect: () => call(v => insertListPlaceholder(v, 'bibliography')) },
        { label: t('menubar.insert.listOfFigures'), icon: 'i-lucide-images', onSelect: () => call(v => insertListPlaceholder(v, 'lof')) },
        { label: t('menubar.insert.listOfTables'), icon: 'i-lucide-table', onSelect: () => call(v => insertListPlaceholder(v, 'lot')) }
      ]
    },
    { label: t('menubar.insert.definitionList'), icon: 'i-lucide-book-open-text', onSelect: () => call(v => insertDefinitionList(v)) },
    { type: 'separator' as const },
    // Toggles a Mistral Voxtral Realtime session that streams speech into the
    // doc at the caret. The label flips so "Stop dictation" is reachable when
    // the toolbar mic button isn't visible.
    {
      label: dictationMenuLabel.value,
      icon: 'i-lucide-mic',
      // Wrapping up after stop: no second session on top.
      disabled: props.dictationState === 'finishing',
      checked: props.dictationState === 'recording' || props.dictationState === 'connecting',
      type: 'checkbox' as const,
      onSelect: () => emit('toggle-dictation')
    }
  ]]
})

const formatItems = computed(() => {
  if (props.isReadOnly) return [[]]
  return [[
    { label: t('editor.bold'), icon: 'i-lucide-bold', kbds: ['meta', 'b'], onSelect: () => call(v => toggleWrap(v, '**')) },
    { label: t('editor.italic'), icon: 'i-lucide-italic', kbds: ['meta', 'i'], onSelect: () => call(v => toggleWrap(v, '*')) },
    { label: t('editor.strikethrough'), icon: 'i-lucide-strikethrough', onSelect: () => call(v => toggleWrap(v, '~~')) },
    { label: t('editor.highlight'), icon: 'i-lucide-highlighter', onSelect: () => call(v => toggleWrap(v, '==')) },
    { label: t('editor.insert'), icon: 'i-lucide-underline', onSelect: () => call(v => toggleWrap(v, '++')) },
    { label: t('menubar.format.inlineCode'), icon: 'i-lucide-code', onSelect: () => call(v => toggleCode(v)) },
    { label: t('editor.subscript'), icon: 'i-lucide-subscript', onSelect: () => call(v => toggleWrap(v, '~')) },
    { label: t('editor.superscript'), icon: 'i-lucide-superscript', onSelect: () => call(v => toggleWrap(v, '^')) },
    { type: 'separator' as const },
    { label: t('editor.list'), icon: 'i-lucide-list', onSelect: () => call(v => toggleLinePrefix(v, '- ')) },
    { label: t('editor.orderedList'), icon: 'i-lucide-list-ordered', onSelect: () => call(v => toggleOrderedList(v)) },
    { label: t('editor.taskList'), icon: 'i-lucide-list-checks', onSelect: () => call(v => toggleLinePrefix(v, '- [ ] ')) }
  ]]
})

const sharingItems = computed(() => [[
  { label: t('menubar.sharing.access'), icon: 'i-lucide-shield', onSelect: () => emit('open-share') },
  { label: t('menubar.sharing.password'), icon: 'i-lucide-key-round', onSelect: () => emit('open-share-password') },
  { type: 'separator' as const },
  {
    label: t('menubar.sharing.copyLink'),
    icon: 'i-lucide-link',
    onSelect: () => copyToClipboard(globalThis.location.href)
  }
]])

const helpItems = computed(() => [[
  {
    label: t('menubar.help.docs'),
    icon: 'i-lucide-book-open',
    onSelect: () => emit('open-docs')
  },
  {
    label: t('menubar.help.shortcuts'),
    icon: 'i-lucide-keyboard',
    onSelect: () => emit('open-shortcuts')
  },
  {
    label: t('menubar.help.tour'),
    icon: 'i-lucide-map',
    onSelect: () => emit('start-tour')
  },
  { type: 'separator' as const },
  {
    label: t('menubar.help.feedback'),
    icon: 'i-lucide-message-circle',
    onSelect: () => window.open(SOURCE_REPO_NEW_ISSUE_URL, '_blank', 'noopener,noreferrer')
  },
  {
    label: t('menubar.help.github'),
    icon: 'i-simple-icons-github',
    onSelect: () => window.open(SOURCE_REPO_URL, '_blank', 'noopener,noreferrer')
  }
]])

// Common trigger styling so the menus read as one bar.
const triggerClass = 'px-2.5 py-1 text-sm rounded hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none transition-colors'
</script>

<template>
  <nav
    class="flex items-center gap-0 px-2 border-b border-default shrink-0"
    :aria-label="t('menubar.label')"
  >
    <UDropdownMenu
      :items="fileItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        data-testid="menubar-file"
      >
        {{ t('menubar.file.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="editItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        data-testid="menubar-edit"
      >
        {{ t('menubar.edit.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="viewItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        data-testid="menubar-view"
      >
        {{ t('menubar.view.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="insertItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        :disabled="isReadOnly"
        data-testid="menubar-insert"
      >
        {{ t('menubar.insert.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="formatItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        :disabled="isReadOnly"
        data-testid="menubar-format"
      >
        {{ t('menubar.format.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="sharingItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        data-testid="menubar-sharing"
      >
        {{ t('menubar.sharing.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="helpItems"
      :content="{ align: 'start' }"
    >
      <button
        :class="triggerClass"
        data-testid="menubar-help"
      >
        {{ t('menubar.help.title') }}
      </button>
    </UDropdownMenu>
    <!-- Insert → Generate image with AI; portalled, so it shows on mobile too. -->
    <AiGenerateImageModal
      v-if="loggedIn && !isReadOnly"
      :doc-id="docId"
      :view="view"
      :read-only="isReadOnly"
    />
  </nav>
</template>
