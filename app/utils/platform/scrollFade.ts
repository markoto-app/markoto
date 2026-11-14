export interface ScrollFadeEdges {
  /** Content is hidden before the visible part (scrolled away from the start). */
  start: boolean
  /** Content is hidden after the visible part. */
  end: boolean
}

/**
 * Which edges of a horizontally scrolling strip hide content, so the
 * strip can fade that edge instead of showing a scrollbar. One pixel of
 * tolerance: fractional widths leave sub-pixel remainders at either end.
 */
export function scrollFadeEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollFadeEdges {
  const max = scrollWidth - clientWidth
  if (max <= 1) return { start: false, end: false }
  const left = Math.abs(scrollLeft)
  return { start: left > 1, end: left < max - 1 }
}
