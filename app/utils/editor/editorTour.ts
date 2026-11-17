/**
 * The short first-run tour of the editor (`components/editor/EditorTour.vue`).
 * Pure data + storage helpers, no Nuxt imports, so the flow fixtures can
 * import the storage key to keep the tour out of their screenshots.
 */

/** localStorage key; value `done` once the tour was finished or skipped. */
export const EDITOR_TOUR_STORAGE_KEY = 'markoto:editor-tour'
export const EDITOR_TOUR_DONE = 'done'

export type TourAnchor
  = | { kind: 'testid', id: string }
    | { kind: 'mobileTab', labelKey: string }
    | { kind: 'ariaLabel', labelKey: string, within: string }

export interface EditorTourStep {
  id: string
  /** i18n keys under `editorTour.steps.<id>`. */
  titleKey: string
  bodyKey: string
  anchor: TourAnchor
  side: 'top' | 'bottom' | 'left' | 'right'
}

function step(id: string, anchor: TourAnchor, side: EditorTourStep['side']): EditorTourStep {
  return { id, titleKey: `editorTour.steps.${id}.title`, bodyKey: `editorTour.steps.${id}.body`, anchor, side }
}

/** Desktop: the menu bar, toolbar and sidebar buttons are on screen. */
export const DESKTOP_TOUR_STEPS: readonly EditorTourStep[] = [
  step('write', { kind: 'testid', id: 'view-mode-split' }, 'bottom'),
  step('format', { kind: 'testid', id: 'editor-toolbar' }, 'bottom'),
  step('theme', { kind: 'testid', id: 'sidebar-tab-theme' }, 'bottom'),
  step('share', { kind: 'testid', id: 'access-lock-button' }, 'bottom'),
  step('ai', { kind: 'testid', id: 'ai-prompt-bar' }, 'top'),
  step('help', { kind: 'testid', id: 'menubar-help' }, 'bottom')
]

/** Phones: the bottom tab bar, the edit/preview switch and the menu. */
export const MOBILE_TOUR_STEPS: readonly EditorTourStep[] = [
  step('writeMobile', { kind: 'testid', id: 'mobile-viewmode-bar' }, 'bottom'),
  step('formatMobile', { kind: 'mobileTab', labelKey: 'mobileTabBar.editor' }, 'top'),
  step('theme', { kind: 'mobileTab', labelKey: 'mobileTabBar.themeShort' }, 'top'),
  step('share', { kind: 'testid', id: 'access-lock-button' }, 'bottom'),
  step('ai', { kind: 'testid', id: 'ai-prompt-bar' }, 'top'),
  step('helpMobile', { kind: 'ariaLabel', labelKey: 'common.menu', within: 'header' }, 'bottom')
]

/** CSS selector for an anchor; `label` is the translated label for the label-based kinds. */
export function anchorSelector(anchor: TourAnchor, label: string): string {
  const quoted = JSON.stringify(label)
  if (anchor.kind === 'testid') return `[data-testid="${anchor.id}"]`
  if (anchor.kind === 'mobileTab') return `[data-testid="mobile-tab-bar"] button[aria-label=${quoted}]`
  return `${anchor.within} button[aria-label=${quoted}]`
}

/** Whether the tour was already finished or skipped in this browser. */
export function editorTourDone(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(EDITOR_TOUR_STORAGE_KEY) === EDITOR_TOUR_DONE
  } catch {
    // Storage blocked: don't nag on every visit.
    return true
  }
}

export function markEditorTourDone(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(EDITOR_TOUR_STORAGE_KEY, EDITOR_TOUR_DONE)
  } catch {
    // Best effort.
  }
}

/**
 * Whether the auto-started tour may open. Signed in, the account decides
 * (`editorTourDone` from /api/user/account-status), so the tour shows once
 * per user even after sign-out cleared localStorage; `wait` until that
 * answer is in. Anonymous visitors only have this browser's flag.
 */
export function editorTourAutoStart(args: {
  localDone: boolean
  loggedIn: boolean
  accountPending: boolean
  accountDone: boolean | null
}): 'show' | 'skip' | 'wait' {
  if (args.localDone) return 'skip'
  if (!args.loggedIn) return 'show'
  if (args.accountPending) return 'wait'
  return args.accountDone === true ? 'skip' : 'show'
}

/** How long the user must have stopped typing before the tour may open. */
export const TOUR_TYPING_PAUSE_MS = 3000

/**
 * Milliseconds to wait before the auto-started tour may open: 0 when the
 * last key press is at least `TOUR_TYPING_PAUSE_MS` ago, else the rest of
 * that pause. Someone who opens a document and types right away (a prompt,
 * a sentence) must not have the tour take their keystrokes.
 */
export function tourTypingWait(now: number, lastKeyAt: number): number {
  const since = now - lastKeyAt
  return since >= TOUR_TYPING_PAUSE_MS ? 0 : TOUR_TYPING_PAUSE_MS - since
}
