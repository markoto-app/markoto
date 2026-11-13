/**
 * Trailing-character trimming without a `/x+$/` regex: that shape re-scans
 * every run of the character from each start position, so a long run that
 * is not at the end ("////…/a") costs quadratic time on user-controlled text.
 */
export function trimTrailing(text: string, chars: string): string {
  let end = text.length
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--
  return end === text.length ? text : text.slice(0, end)
}

/** A section heading's text as the section tables compare it: lowercase, no closing colon or full stop. */
export function headingKey(el: Element): string {
  return trimTrailing((el.textContent ?? '').trim().toLowerCase(), ':.：。').trim()
}
