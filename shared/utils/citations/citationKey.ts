import { issuedYear, type CslItem } from './cslItem'

const STOP_WORDS = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'der', 'die', 'das', 'ein', 'eine', 'le', 'la', 'les', 'un', 'une', 'el', 'los'])

function ascii(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '').toLowerCase()
}

/**
 * Better BibTeX-style key for an entry that has none (DOI lookups):
 * first author's family name + year + first significant title word,
 * `smith2020study`; `a`, `b` … appended while `taken` has it.
 */
export function citationKeyFor(item: Pick<CslItem, 'author' | 'editor' | 'issued' | 'title'>, taken: (key: string) => boolean = () => false): string {
  const first = item.author?.[0] ?? item.editor?.[0]
  const name = ascii(first?.family ?? first?.literal?.split(/\s+/)[0] ?? '') || 'ref'
  const year = issuedYear(item as CslItem) ?? ''
  const word = (item.title ?? '').split(/\s+/).map(ascii).find(w => w.length > 2 && !STOP_WORDS.has(w)) ?? ''
  const base = `${name.slice(0, 30)}${year}${word.slice(0, 20)}`
  if (!taken(base)) return base
  for (let i = 0; i < 26 * 26; i++) {
    const suffix = i < 26 ? String.fromCodePoint(97 + i) : `${String.fromCodePoint(97 + Math.floor(i / 26) - 1)}${String.fromCodePoint(97 + (i % 26))}`
    if (!taken(base + suffix)) return base + suffix
  }
  return `${base}${Date.now()}`
}

/** `10.1000/xyz`, `doi:10.1000/xyz` or a doi.org URL → the bare DOI (lower-cased prefix kept as typed), or null. */
export function normalizeDoi(input: string): string | null {
  const s = input.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
  try {
    const decoded = decodeURIComponent(s)
    return /^10\.\d{4,9}\/\S{1,250}$/.test(decoded) ? decoded : null
  } catch {
    return null
  }
}
