<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import {
  toggleWrap, toggleHeading, toggleLinePrefix, toggleOrderedList, toggleCode,
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
  // Right-sidebar state — used to render check marks next to "Activity"
  // and "Theme" in the View menu so the user can see what's currently open.
  rightSidebar: 'activity' | 'theme' | null
  // View mode: 'edit' | 'split' | 'preview'.
  viewMode: 'edit' | 'split' | 'preview'
}>()

const emit = defineEmits<{
  'open-import': []
  'open-share': []
  'open-share-password': []
  'export-markdown': []
  'export-pdf': []
  'new-document': []
  'delete-document': []
  'set-view-mode': ['edit' | 'split' | 'preview']
  'toggle-sidebar': ['activity' | 'theme']
  'undo': []
  'redo': []
  'open-image-picker': []
  // Table size picker — handed up to EditorLayout which owns the
  // shared open state. The toolbar's anchored UPopover is the single
  // visual surface; menu just opens it.
  'open-table-picker': []
  // Format / insert dispatch on the editor view directly via callbacks
  // rather than emits so we don't have to re-thread every command up
  // through EditorLayout. The view ref is sufficient.
}>()

const { t, locale, locales, setLocale } = useI18n()
const colorMode = useColorMode()

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
  items.push({
    label: t('menubar.file.export'),
    icon: 'i-lucide-download',
    children: [
      { label: t('export.markdown'), icon: 'i-lucide-file-text', onSelect: () => emit('export-markdown') },
      { label: t('export.pdf'), icon: 'i-lucide-file-output', onSelect: () => emit('export-pdf') }
    ]
  })
  items.push({ type: 'separator' })
  items.push({ label: t('menubar.file.print'), icon: 'i-lucide-printer', kbds: ['cmd', 'p'], onSelect: () => emit('export-pdf') })
  // Delete sits at the bottom of File — destructive, kept under a
  // separator so it's not a one-click slip from the export entries.
  // Owner-only (the destination handler also enforces it).
  if (props.loggedIn) {
    items.push({ type: 'separator' })
    items.push({ label: t('menubar.file.delete'), icon: 'i-lucide-trash-2', onSelect: () => emit('delete-document') })
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
    }
  ],
  // Display preferences
  [
    {
      label: colorMode.value === 'dark' ? t('menu.lightMode') : t('menu.darkMode'),
      icon: colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
      onSelect: () => { colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark' }
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
    { label: t('menubar.insert.definitionList'), icon: 'i-lucide-book-open-text', onSelect: () => call(v => insertDefinitionList(v)) }
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
    onSelect: async () => {
      try {
        await navigator.clipboard.writeText(window.location.href)
      } catch {
        // older browsers / iframe contexts
      }
    }
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
    onSelect: () => window.open('https://github.com/joelbarmettleruzh/md-online/issues/new', '_blank')
  },
  {
    label: t('menubar.help.github'),
    icon: 'i-simple-icons-github',
    onSelect: () => window.open('https://github.com/joelbarmettleruzh/md-online', '_blank')
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
      <button :class="triggerClass">
        {{ t('menubar.file.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="editItems"
      :content="{ align: 'start' }"
    >
      <button :class="triggerClass">
        {{ t('menubar.edit.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="viewItems"
      :content="{ align: 'start' }"
    >
      <button :class="triggerClass">
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
      >
        {{ t('menubar.format.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="sharingItems"
      :content="{ align: 'start' }"
    >
      <button :class="triggerClass">
        {{ t('menubar.sharing.title') }}
      </button>
    </UDropdownMenu>
    <UDropdownMenu
      :items="helpItems"
      :content="{ align: 'start' }"
    >
      <button :class="triggerClass">
        {{ t('menubar.help.title') }}
      </button>
    </UDropdownMenu>
  </nav>
</template>
