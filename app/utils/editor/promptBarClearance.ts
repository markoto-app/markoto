interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

/** The prompt bar's pill (`AIPromptBar.vue`), the part that covers text. */
const PROMPT_BAR_SELECTOR = '.ai-prompt-bar__shell'

/** Space kept between the caret's line and the bar. */
const GAP_PX = 16

/**
 * How much of the editor's bottom edge the floating AI prompt bar covers,
 * plus a small gap: the editor keeps the caret's line above that, so text
 * typed or dictated into the last line isn't hidden under the bar. 0 when
 * the bar isn't over the editor (not rendered, or beside it). Capped at
 * half the editor so a tall bar (keyboard up on a phone) can't push the
 * caret out of the top.
 */
export function clearanceUnderBar(scroller: Box, bar: Box | null): number {
  if (!bar) return 0
  const overlapsSideways = bar.left < scroller.right && bar.right > scroller.left
  const overlapsVertically = bar.top < scroller.bottom && bar.bottom > scroller.top
  if (!overlapsSideways || !overlapsVertically) return 0
  const height = scroller.bottom - scroller.top
  return Math.max(0, Math.min(scroller.bottom - bar.top + GAP_PX, height / 2))
}

/** `clearanceUnderBar` for the live page. */
export function promptBarClearance(scroller: HTMLElement): number {
  const bar = scroller.ownerDocument.querySelector(PROMPT_BAR_SELECTOR)
  return clearanceUnderBar(scroller.getBoundingClientRect(), bar ? bar.getBoundingClientRect() : null)
}
