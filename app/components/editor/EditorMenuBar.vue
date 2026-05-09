<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import {
  toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList, toggleCode, toggleComment,
  insertBlock, insertFootnote, insertAlert, insertMath, insertDiagram,
  insertToc, insertPageBreak, insertDefinitionList
} from '~/utils/editorCommands'

/**
 * Top-level menu bar — Google-Docs-style. Replaces the assortment of
 * icon-only buttons that were previously scattered between the title row
 * and the formatting toolbar with discoverable, labeled menus.
 *
 * High-frequency actions (formatting toolbar, view-mode toggles, sidebar
 * toggles in the corner) intentionally still have visible header
 * shortcuts — the menu items duplicate them for discoverability, not as
 * the only entry point.
 */

const props = defineProps<{
  view: EditorView | null
  docId: string
  isReadOnly: boolean
  loggedIn: boolean
  // Can the user perform sharing/delete-grade actions on this doc? Owner
  // or workspace admin only. Gates the destructive / ownership-changing
  // entries in File (Move, Delete).
  canManage: boolean
  // Right-sidebar state — used to render check marks next to "Activity"
  // and "Theme" in the View menu so the user can see what's currently open.
  rightSidebar: 'document' | 'activity' | 'theme' | 'knowledge' | 'comments' | null
  // Whether the current doc belongs to a workspace the viewer is a
  // member of. Only then is the Knowledge panel meaningful — gate the
  // menu entry on this so non-workspace docs don't show a disabled item.
  hasKnowledgeAccess: boolean
  // View mode: 'edit' | 'split' | 'preview'.
  viewMode: 'edit' | 'split' | 'preview'
  /**
   * Current live-dictation state, hoisted from the parent so the
   * Insert menu can toggle the label between "Start" / "Stop
   * dictation" and show a check mark while active.
   */
  dictationState?: 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'error'
}>()

const emit = defineEmits<{
  'open-import': []
  'open-share': []
  'open-share-password': []
  'export-markdown': []
  'export-pdf': []
  // Server-rendered PDF (Playwright + paged.js) — opens in a new tab
  // via the /api/docs/:id/pdf endpoint. Distinct from `export-pdf`
  // (which goes through the browser's in-tab print dialog).
  'open-server-pdf': []
  'new-document': []
  'duplicate-document': []
  'move-document': []
  'delete-document': []
  'set-view-mode': ['edit' | 'split' | 'preview']
  'toggle-sidebar': ['document' | 'activity' | 'theme' | 'knowledge' | 'comments']
  'undo': []
  'redo': []
  'open-image-picker': []
  // Table size picker — handed up to EditorLayout which owns the
  // shared open state. The toolbar's anchored UPopover is the single
  // visual surface; menu just opens it.
  'open-table-picker': []
  // Dictation toggle — hoisted to the parent where the composable
  // owns the editor + ydoc + awareness wiring.
  'toggle-dictation': []
  // Insert → Comment. Parent captures the current selection, opens the
  // sidebar, focuses the composer.
  'create-comment': []
  // Format / insert dispatch on the editor view directly via callbacks
  // rather than emits so we don't have to re-thread every command up
  // through EditorLayout. The view ref is sufficient.
}>()

const { t, locale, locales, setLocale } = useI18n()
// Defer color-mode read to onMounted — useColorMode() returns 'light' on SSR
// (no prefers-color-scheme + no localStorage), so reading at top-level causes
// hydration mismatch when the user's actual mode is dark. The brief
// light-mode flash on first paint is acceptable for this component;
// see app/AGENTS.md "Common Vue conventions" section.
const colorMode = useColorMode()
const colorModeValue = ref<'light' | 'dark'>('light')
onMounted(() => {
  colorModeValue.value = colorMode.value === 'dark' ? 'dark' : 'light'
})
watch(() => colorMode.value, (v) => {
  colorModeValue.value = v === 'dark' ? 'dark' : 'light'
})
// Sharing → Copy link. `useClipboard` adds a legacy execCommand fallback
// for iframe / older-browser contexts the bare Async Clipboard API
// doesn't reach, and silently no-ops on `isSupported === false`.
const { copy: copyToClipboard } = useClipboard()

// ── Editor command helpers — delegate to shared utils so menu and
// toolbar produce identical output (smart toggle, whitespace trim,
// prefix replacement instead of dumb prepend). See
// `app/utils/editorCommands.ts`.

function call(fn: (v: EditorView) => void) {
  if (!props.view || props.isReadOnly) return
  fn(props.view)
}

// ── Menu item builders ──────────────────────────────────────────────
//
// Nuxt UI v4 UDropdownMenu items support: label, icon, kbds (kbd
// shortcut chip), onSelect, disabled, type ('separator'|'label'),
// children (submenu), checked (radio/check). We use that vocabulary
// throughout so the menus all look consistent.

const fileItems = computed(() => {
  const items: Array<Record<string, unknown>> = [
    { label: t('menubar.file.new'), icon: 'i-lucide-file-plus', onSelect: () => emit('new-document') }
  ]
  if (!props.isReadOnly) {
    items.push({ label: t('menubar.file.import'), icon: 'i-lucide-file-up', onSelect: () => emit('open-import') })
  }
  items.push(
    {
      label: t('menubar.file.export'),
      icon: 'i-lucide-download',
      children: [
        { label: t('export.markdown'), icon: 'i-lucide-file-text', onSelect: () => emit('export-markdown') },
        // PDF export goes through the server renderer (Playwright + paged.js)
        // and opens the result in a new tab inline — distinct from File →
        // Print, which uses the in-browser print dialog.
        { label: t('export.pdf'), icon: 'i-lucide-file-output', onSelect: () => emit('open-server-pdf') }
      ]
    },
    { type: 'separator' },
    { label: t('menubar.file.print'), icon: 'i-lucide-printer', kbds: ['cmd', 'p'], onSelect: () => emit('export-pdf') }
  )
  // Duplicate is available to anyone who can edit the doc (server
  // re-checks); Move requires manage rights. Both need login — the
  // server rejects anonymous on both paths because they need an owner.
  if (props.loggedIn) {
    items.push(
      { type: 'separator' },
      { label: t('menubar.file.duplicate'), icon: 'i-lucide-copy', onSelect: () => emit('duplicate-document') }
    )
    if (props.canManage) {
      items.push({ label: t('menubar.file.move'), icon: 'i-lucide-folder-input', onSelect: () => emit('move-document') })
    }
    // Delete sits at the bottom of File — destructive, kept under its
    // own separator so it's not a one-click slip from the copy/move
    // entries.
    items.push(
      { type: 'separator' },
      { label: t('menubar.file.delete'), icon: 'i-lucide-trash-2', onSelect: () => emit('delete-document') }
    )
  }
  return [items]
})

const editItems = computed(() => {
  const items: Array<Record<string, unknown>> = [
    { label: t('menubar.edit.undo'), icon: 'i-lucide-undo-2', kbds: ['cmd', 'z'], disabled: props.isReadOnly, onSelect: () => emit('undo') },
    { label: t('menubar.edit.redo'), icon: 'i-lucide-redo-2', kbds: ['cmd', 'shift', 'z'], disabled: props.isReadOnly, onSelect: () => emit('redo') }
  ]
  return [items]
})

const viewItems = computed(() => [
  // View mode (radio-style: only one active)
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
    }
  ],
  // Right-sidebar toggles (independent — but mutually exclusive in the
  // parent; we only render the check on whichever is active)
  [
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
    // Knowledge — only meaningful for workspace docs. Hidden otherwise
    // so the menu doesn't advertise a capability that isn't available.
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
  // Display preferences
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

// Link is a special case (asymmetric wrap with URL placeholder).
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

const insertItems = computed(() => {
  if (props.isReadOnly) return [[]]
  return [[
    { label: t('editor.image'), icon: 'i-lucide-image', onSelect: () => emit('open-image-picker') },
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
    // Opens the same hover-grid picker the toolbar's Table button uses.
    // EditorLayout owns the shared open-state ref.
    { label: t('editor.table'), icon: 'i-lucide-table', onSelect: () => emit('open-table-picker') },
    { label: t('editor.horizontalRule'), icon: 'i-lucide-minus', onSelect: () => call(v => insertBlock(v, '\n---\n')) },
    { label: t('editor.pageBreak'), icon: 'i-lucide-scissors-line-dashed', onSelect: () => call(v => insertPageBreak(v)) },
    { label: t('editor.hideFromPreview'), icon: 'i-lucide-eye-off', onSelect: () => call(v => toggleComment(v)) },
    // Discussion comment — separate from the markdown comment above.
    // The markdown one stays in the source (hidden from preview);
    // this one opens a thread in the sidebar with replies + resolve.
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
    { label: t('menubar.insert.definitionList'), icon: 'i-lucide-book-open-text', onSelect: () => call(v => insertDefinitionList(v)) },
    { type: 'separator' as const },
    // Live voice dictation — toggles a Mistral Voxtral Realtime
    // session that streams transcribed speech into the doc at the
    // caret. Label flips so "Stop dictation" is reachable even when
    // the toolbar mic button isn't visible (e.g. a user who lives in
    // the menu).
    {
      label: props.dictationState === 'recording' || props.dictationState === 'connecting'
        ? t('ai.dictateStop')
        : t('ai.dictateStart'),
      icon: 'i-lucide-mic',
      checked: props.dictationState === 'recording' || props.dictationState === 'connecting',
      type: 'checkbox' as const,
      onSelect: () => emit('toggle-dictation')
    }
  ]]
})

const formatItems = computed(() => {
  if (props.isReadOnly) return [[]]
  return [[
    { label: t('editor.bold'), icon: 'i-lucide-bold', kbds: ['cmd', 'b'], onSelect: () => call(v => toggleWrap(v, '**')) },
    { label: t('editor.italic'), icon: 'i-lucide-italic', kbds: ['cmd', 'i'], onSelect: () => call(v => toggleWrap(v, '*')) },
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
    label: t('menubar.help.shortcuts'),
    icon: 'i-lucide-keyboard',
    disabled: true // Not built yet — will surface a kbd cheat sheet later.
  },
  { type: 'separator' as const },
  {
    label: t('menubar.help.feedback'),
    icon: 'i-lucide-message-circle',
    onSelect: () => window.open('https://github.com/joelbarmettleruzh/md-online/issues/new', '_blank', 'noopener,noreferrer')
  },
  {
    label: t('menubar.help.github'),
    icon: 'i-simple-icons-github',
    onSelect: () => window.open('https://github.com/joelbarmettleruzh/md-online', '_blank', 'noopener,noreferrer')
  }
]])

// Trigger styling — common to every menu so they look like a single bar.
const triggerClass = 'px-2.5 py-1 text-sm rounded hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none transition-colors'
</script>

<template>
  <nav
    class="flex items-center gap-0 px-2 border-b border-default shrink-0"
    aria-label="Menu bar"
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
  </nav>
</template>
