// The editor's left panel (outline and the documents around this one):
// what the browser remembers about it, how it starts and its shortcut.
// Pure; `useEditorLeftPanel` wires it up.

export const LEFT_PANEL_TABS = ['outline', 'workspace'] as const
export type LeftPanelTab = typeof LEFT_PANEL_TABS[number]

/** localStorage key: one setting per browser, not per document. */
export const LEFT_PANEL_STORAGE_KEY = 'markoto:editor-left-panel'

/**
 * From this width (Tailwind `xl`) the panel sits beside the editor;
 * narrower, it lies over the editor so editor and preview keep their width.
 */
export const LEFT_PANEL_INLINE_QUERY = '(min-width: 1280px)'

/**
 * Until the person has opened or closed the panel themselves, it starts
 * open from this width only. At 1280px the editor and preview already share
 * little room, and another 260px would shrink the preview's page below a
 * readable size.
 */
export const LEFT_PANEL_DEFAULT_OPEN_QUERY = '(min-width: 1440px)'

/** The toggle, in CodeMirror notation (Help → Keyboard shortcuts). */
export const LEFT_PANEL_SHORTCUT = 'Mod-Shift-e'

export interface LeftPanelPrefs {
  open: boolean
  tab: LeftPanelTab
}

function isTab(v: unknown): v is LeftPanelTab {
  return typeof v === 'string' && (LEFT_PANEL_TABS as readonly string[]).includes(v)
}

/** The remembered setting, or null when there is none (or storage is blocked or holds junk). */
export function readLeftPanelPrefs(storage: Pick<Storage, 'getItem'> | null): LeftPanelPrefs | null {
  try {
    const raw = storage?.getItem(LEFT_PANEL_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { open, tab } = parsed as Record<string, unknown>
    if (typeof open !== 'boolean') return null
    return { open, tab: isTab(tab) ? tab : 'outline' }
  } catch {
    return null
  }
}

/** Remember the setting; a blocked or full storage just doesn't remember. */
export function writeLeftPanelPrefs(storage: Pick<Storage, 'setItem'> | null, prefs: LeftPanelPrefs): void {
  try {
    storage?.setItem(LEFT_PANEL_STORAGE_KEY, JSON.stringify(prefs))
  } catch { /* private mode or quota: not remembered */ }
}

/**
 * How the panel starts on page load. A remembered choice wins where the
 * panel sits beside the editor; where it would lie over the editor it
 * always starts closed (an overlay that opens by itself hides the text).
 * Without a choice: open with the outline on wide screens only.
 */
export function initialLeftPanelState(stored: LeftPanelPrefs | null, screen: { inline: boolean, wide: boolean }): LeftPanelPrefs {
  if (stored) return { open: stored.open && screen.inline, tab: stored.tab }
  return { open: screen.wide, tab: 'outline' }
}

/** Ctrl+Shift+E (Cmd+Shift+E on a Mac). Non-Latin layouts match by the physical key. */
export function isLeftPanelShortcut(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || !e.shiftKey || e.altKey) return false
  const key = e.key.toLowerCase()
  if (key === 'e') return true
  return !/^[a-z]$/.test(key) && e.code === 'KeyE'
}
