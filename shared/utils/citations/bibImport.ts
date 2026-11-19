import { parse as parseYaml } from 'yaml'
import { parseBibtex } from './bibtex'
import { BIBLIOGRAPHY_MAX_ENTRIES, normalizeCslItem, type CslItem } from './cslItem'

/** Largest bibliography file / paste read at once (a 2000-entry .bib is ~1.5 MB). */
export const BIBLIOGRAPHY_IMPORT_MAX_BYTES = 4 * 1024 * 1024

export type BibliographyFormat = 'bibtex' | 'csl-json' | 'csl-yaml'

export interface BibliographyImport {
  format: BibliographyFormat | null
  items: CslItem[]
  /** Entries found but unreadable (no key, no content, syntax error). */
  skipped: number
}

/** A CSL JSON / YAML document: a list of items, `{ items: [...] }` or Pandoc's `{ references: [...] }`. */
function cslList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (Array.isArray(d.references)) return d.references
    if (Array.isArray(d.items)) return d.items
    if (typeof d.id === 'string' || typeof d.type === 'string') return [d]
  }
  return null
}

/** Items of a CSL JSON / YAML list (each normalised, bounded). */
export function cslItemsFrom(list: unknown[]): { items: CslItem[], skipped: number } {
  const items: CslItem[] = []
  let skipped = 0
  for (const raw of list.slice(0, BIBLIOGRAPHY_MAX_ENTRIES)) {
    const item = normalizeCslItem(raw)
    if (item) items.push(item)
    else skipped++
  }
  return { items, skipped }
}

/**
 * Read a bibliography in any supported format: BibTeX / BibLaTeX (`.bib`,
 * Zotero's "Better BibTeX" or plain BibTeX export, a pasted entry), CSL
 * JSON (Zotero's "CSL JSON" export, Crossref) or CSL YAML (Pandoc
 * `references:`). The format is detected from the content. Later
 * duplicates of a key replace earlier ones.
 */
export function parseBibliographyText(text: string): BibliographyImport {
  const src = text.length > BIBLIOGRAPHY_IMPORT_MAX_BYTES ? text.slice(0, BIBLIOGRAPHY_IMPORT_MAX_BYTES) : text
  const trimmed = src.replace(/^﻿/, '').trim()
  if (!trimmed) return { format: null, items: [], skipped: 0 }
  let result: BibliographyImport | null = null
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const list = cslList(JSON.parse(trimmed))
      if (list) result = { format: 'csl-json', ...cslItemsFrom(list) }
    } catch {
      // Not JSON: try the other formats.
    }
  }
  if (!result && /@[a-z]+\s*[{(]/i.test(trimmed)) {
    const bib = parseBibtex(trimmed)
    if (bib.items.length > 0 || bib.skipped > 0) result = { format: 'bibtex', ...bib }
  }
  if (!result) {
    try {
      const list = cslList(parseYaml(trimmed.replace(/^---\n/, '').replace(/\n(?:---|\.\.\.)\s*$/, ''), { maxAliasCount: 0 }))
      if (list) result = { format: 'csl-yaml', ...cslItemsFrom(list) }
    } catch {
      // Not YAML either.
    }
  }
  if (!result) return { format: null, items: [], skipped: 0 }
  const byKey = new Map<string, CslItem>()
  for (const item of result.items) byKey.set(item.id, item)
  return { ...result, items: [...byKey.values()].slice(0, BIBLIOGRAPHY_MAX_ENTRIES) }
}
