// The `YYYY-MM-DD` date shape of `cover.date`. A leaf (and outside the
// auto-imported dirs): the theme schema (`shared/types/theme.ts`) validates
// with it, and the document-locale helpers, which import the theme types,
// re-export it for the editor.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Is `value` a real calendar date written `YYYY-MM-DD`? */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}
