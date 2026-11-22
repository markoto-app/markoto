import { useMediaQuery } from '@vueuse/core'
import type { EditorView } from '@codemirror/view'
import type { TabName } from '~/components/editor/tabBarTypes'
import type { OutlineHeading } from '~/utils/editor/documentOutline'
import { jumpEditorToLine } from '~/utils/editor/outlineJump'
import {
  LEFT_PANEL_DEFAULT_OPEN_QUERY, LEFT_PANEL_INLINE_QUERY, initialLeftPanelState, isLeftPanelShortcut,
  readLeftPanelPrefs, writeLeftPanelPrefs, type LeftPanelTab
} from '~/utils/editor/leftPanel'
import { isMacPlatform } from '~/utils/preview/previewZoom'

/**
 * The editor's left panel (Outline / Workspace): open or closed, the tab,
 * beside the editor (`inline`, xl and up) or over it, the Ctrl/Cmd + Shift
 * + E toggle, and what a click on a heading does (cursor and editor scroll
 * to it, preview scrolls to it). Remembered per browser (`leftPanel.ts`),
 * read after mount, so the server render and hydration never depend on it.
 * On a phone the panel is the "navigator" bottom sheet of the right slot.
 *
 * Reads the layout's template refs `leftPanelContent` (the panel, to focus
 * its tabs) and `previewPane` (to scroll the pages).
 */
export function useEditorLeftPanel(opts: {
  editorView: Readonly<Ref<EditorView | null>>
  isMobile: Readonly<Ref<boolean>>
  rightSidebar: Ref<TabName | null>
  docId: string
  source: Readonly<Ref<string>>
  workspaceId: Readonly<Ref<string | null>>
  workspaceRole: Readonly<Ref<string | null>>
}) {
  const inline = useMediaQuery(LEFT_PANEL_INLINE_QUERY)
  const open = ref(false)
  const tab = ref<LeftPanelTab>('outline')
  let rememberedOpen = false
  const content = useTemplateRef<{ focusTabs: () => void }>('leftPanelContent')
  const preview = useTemplateRef<{ scrollToHeading: (id: string) => void }>('previewPane')

  function storage(): Storage | null {
    try {
      return import.meta.client ? globalThis.localStorage : null
    } catch {
      return null
    }
  }

  onMounted(() => {
    const stored = readLeftPanelPrefs(storage())
    const start = initialLeftPanelState(stored, {
      inline: globalThis.matchMedia?.(LEFT_PANEL_INLINE_QUERY).matches ?? false,
      wide: globalThis.matchMedia?.(LEFT_PANEL_DEFAULT_OPEN_QUERY).matches ?? false
    })
    rememberedOpen = stored?.open ?? start.open
    open.value = start.open
    tab.value = start.tab
  })

  // Narrowing the window turns the panel into an overlay: close it rather
  // than lay it over the text; widening again restores the remembered state.
  watch(inline, (wide) => {
    open.value = wide ? rememberedOpen : false
  })

  function persist() {
    rememberedOpen = open.value
    writeLeftPanelPrefs(storage(), { open: open.value, tab: tab.value })
  }

  function setOpen(value: boolean) {
    open.value = value
    persist()
  }

  function toggle() {
    setOpen(!open.value)
  }

  function setTab(value: LeftPanelTab) {
    tab.value = value
    persist()
  }

  function jumpToHeading(heading: OutlineHeading) {
    const view = opts.editorView.value
    // No focus on a phone: it would open the on-screen keyboard over the text.
    if (view) jumpEditorToLine(view, heading.line, { focus: !opts.isMobile.value })
    preview.value?.scrollToHeading(heading.id)
    if (opts.rightSidebar.value === 'navigator') opts.rightSidebar.value = null
  }

  if (import.meta.client) {
    // Capture phase: before CodeMirror, which would otherwise see the keys first.
    // Opened from the keyboard, focus goes to the panel's tabs; closed, back to the text.
    useEventListener(globalThis, 'keydown', (e: KeyboardEvent) => {
      if (opts.isMobile.value || !isLeftPanelShortcut(e, isMacPlatform())) return
      e.preventDefault()
      toggle()
      if (open.value) void nextTick(() => content.value?.focusTabs())
      else opts.editorView.value?.focus()
    }, { capture: true })
  }

  /** Everything the panel component takes, data and listeners (`v-bind`). */
  const panelProps = computed(() => ({
    'tab': tab.value,
    'source': opts.source.value,
    'view': opts.editorView.value,
    'docId': opts.docId,
    'workspaceId': opts.workspaceId.value,
    'workspaceRole': opts.workspaceRole.value,
    'onUpdate:tab': setTab,
    'onSelectHeading': jumpToHeading
  }))

  return { open: readonly(open), tab: readonly(tab), inline, toggle, setOpen, setTab, jumpToHeading, panelProps }
}
