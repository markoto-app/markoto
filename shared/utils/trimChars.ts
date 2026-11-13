// Linear trims of a character set from a string's ends. A regex such as
// `/-+$/` or `/[.,;]+$/` backtracks quadratically on a long run of those
// characters that is NOT at the end (every start position rescans the
// run), and several call sites trim user input (slugs, hostnames, URLs
// the AI reads). These scans are exactly linear.

/** `value` without the characters of `chars` at its end. */
export function trimEndChars(value: string, chars: string): string {
  let end = value.length
  while (end > 0 && chars.includes(value.charAt(end - 1))) end--
  return end === value.length ? value : value.slice(0, end)
}

/** `value` without the characters of `chars` at its start. */
function trimStartChars(value: string, chars: string): string {
  let start = 0
  while (start < value.length && chars.includes(value.charAt(start))) start++
  return start === 0 ? value : value.slice(start)
}

/** `value` without the characters of `chars` at either end. */
export function trimChars(value: string, chars: string): string {
  return trimEndChars(trimStartChars(value, chars), chars)
}
