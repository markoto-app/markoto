import { languageTagOf } from '../../languages'
import { documentLocale } from './documentLocale'

/**
 * Document-level metadata the server PDF carries for assistive technology
 * (PDF/UA: a natural language and a title). The print page writes both
 * into the HTML (`<html lang>`, `<title>`), Chromium copies them into the
 * tagged PDF.
 */

/** Title for an untitled document: PDF/UA needs a non-empty one. */
export const UNTITLED_PDF_TITLE = 'Untitled'

/**
 * BCP 47 tag for the document's `language` field, which holds an ISO code
 * ("de", "de-CH") or a typed language name ("Deutsch", "français",
 * "Schwiizerdütsch"). An empty field is the schema default, English.
 * A value that names no known language gives `und` (BCP 47
 * "undetermined"): claiming English for a text we can't identify would
 * make a screen reader read it with the wrong voice.
 */
export function documentLanguageTag(language: string | null | undefined): string {
  const raw = (language ?? '').trim()
  if (!raw) return 'en'
  const tag = languageTagOf(raw)
  if (tag) return tag
  // documentLocale knows a few names Intl does not (Swiss German,
  // Romansh spellings) and falls back to `en` for anything else.
  const named = documentLocale(raw)
  return named === 'en' ? 'und' : named
}

/** The document title as the PDF's title: whitespace collapsed, never empty. */
export function pdfDocumentTitle(title: string | null | undefined): string {
  const collapsed = (title ?? '').replace(/\s+/g, ' ').trim()
  return collapsed || UNTITLED_PDF_TITLE
}
