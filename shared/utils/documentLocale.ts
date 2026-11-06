import type { DocTheme } from '../types/theme'

/**
 * Locale-dependent text that ends up IN the document (cover date, the
 * `{date}` header/footer token, the TOC title, chart number formats).
 * It follows the document's language (`ymeta.language`, the Document
 * tab) — not the viewer's UI language: a German report prints German
 * dates and "Inhalt" for every reader. Shared by the live preview, the
 * browser print path and the server render page so all three agree.
 */

/** Free-text language names users type into the Document tab. */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en',
  englisch: 'en',
  anglais: 'en',
  deutsch: 'de',
  german: 'de',
  allemand: 'de',
  schwiizerdütsch: 'de-CH',
  schweizerdeutsch: 'de-CH',
  français: 'fr',
  francais: 'fr',
  french: 'fr',
  französisch: 'fr',
  español: 'es',
  espanol: 'es',
  spanish: 'es',
  italiano: 'it',
  italian: 'it',
  italienisch: 'it',
  nederlands: 'nl',
  dutch: 'nl',
  português: 'pt',
  portugues: 'pt',
  portuguese: 'pt',
  polski: 'pl',
  polish: 'pl',
  svenska: 'sv',
  swedish: 'sv',
  dansk: 'da',
  danish: 'da',
  norsk: 'nb',
  norwegian: 'nb',
  suomi: 'fi',
  finnish: 'fi',
  čeština: 'cs',
  czech: 'cs',
  romantsch: 'rm',
  rumantsch: 'rm',
  japanese: 'ja',
  日本語: 'ja',
  chinese: 'zh',
  中文: 'zh'
}

/**
 * BCP-47 tag for a stored document language: a preset/ISO code (`de`,
 * `de-CH`), a known language name (`Deutsch`, `english`) or anything else
 * (→ `en`). Never throws.
 */
export function documentLocale(language: string | null | undefined): string {
  const raw = (language ?? '').trim()
  if (!raw) return 'en'
  const named = LANGUAGE_NAMES[raw.toLowerCase()]
  if (named) return named
  if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(raw)) {
    try {
      const [canonical] = Intl.getCanonicalLocales(raw)
      if (canonical && Intl.DateTimeFormat.supportedLocalesOf([canonical]).length > 0) return canonical
    } catch {
      // Malformed tag — fall through to the default.
    }
  }
  return 'en'
}

/** Primary language subtag (`de-CH` → `de`). */
function primary(locale: string): string {
  return (locale.split('-')[0] ?? 'en').toLowerCase()
}

/** Sentence-case TOC heading per language. */
const TOC_TITLES: Record<string, string> = {
  en: 'Contents',
  de: 'Inhalt',
  fr: 'Sommaire',
  es: 'Índice',
  it: 'Indice',
  pt: 'Índice',
  nl: 'Inhoud',
  pl: 'Spis treści',
  sv: 'Innehåll',
  da: 'Indhold',
  nb: 'Innhold',
  no: 'Innhold',
  fi: 'Sisällys',
  cs: 'Obsah',
  rm: 'Cuntegn',
  ja: '目次',
  zh: '目录'
}

export function tocTitleFor(locale: string): string {
  return TOC_TITLES[primary(locale)] ?? 'Contents'
}

/** Caption label words per language: [table, figure]. */
const CAPTION_LABELS: Record<string, readonly [string, string]> = {
  en: ['Table', 'Figure'],
  de: ['Tabelle', 'Abbildung'],
  fr: ['Tableau', 'Figure'],
  es: ['Tabla', 'Figura'],
  it: ['Tabella', 'Figura'],
  pt: ['Tabela', 'Figura'],
  nl: ['Tabel', 'Figuur'],
  pl: ['Tabela', 'Rysunek'],
  sv: ['Tabell', 'Figur'],
  da: ['Tabel', 'Figur'],
  nb: ['Tabell', 'Figur'],
  no: ['Tabell', 'Figur'],
  fi: ['Taulukko', 'Kuva'],
  cs: ['Tabulka', 'Obrázek'],
  rm: ['Tabella', 'Figura'],
  ja: ['表', '図'],
  zh: ['表', '图']
}

/**
 * Caption labels in the document language: the word before the number
 * (`Table` / `Tabelle`) and what follows the number (`: `; French sets a
 * no-break space before the colon).
 */
export function captionLabelsFor(locale: string): { table: string, figure: string, separator: string } {
  const lang = primary(locale)
  const [table, figure] = CAPTION_LABELS[lang] ?? ['Table', 'Figure']
  return { table, figure, separator: lang === 'fr' ? '\u00A0: ' : ': ' }
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Is `value` a real calendar date written `YYYY-MM-DD`? */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/** Today's date (local time zone) as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Long date in the document language: `29 October 2026`, `29. Oktober
 * 2026`, `29 octobre 2026`, `2026年10月29日`. Plain `en` uses the
 * day-month-year order (`en-US` gives `October 29, 2026`). An invalid
 * input is returned unchanged.
 */
export function formatDocumentDate(iso: string, locale: string): string {
  if (!isIsoDate(iso)) return iso
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  const tag = locale === 'en' ? 'en-GB' : locale
  try {
    return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
  } catch {
    return iso
  }
}

export interface DocumentTexts {
  /** BCP-47 tag of the document language. */
  locale: string
  /** Publication date `YYYY-MM-DD`: `theme.cover.date`, else today. */
  dateIso: string
  /** `dateIso` written out in the document language (cover + `{date}`). */
  date: string
  /** TOC heading in the document language. */
  tocTitle: string
  /** Caption labels ("Table" / "Figure" + separator) in the document language. */
  captionLabels: { table: string, figure: string, separator: string }
}

/** Everything locale-dependent a render needs, from the theme + document language. */
export function documentTexts(theme: Pick<DocTheme, 'cover'>, language: string | null | undefined, now: Date = new Date()): DocumentTexts {
  const locale = documentLocale(language)
  const picked = theme.cover.date ?? ''
  const dateIso = picked && isIsoDate(picked) ? picked : todayIso(now)
  return { locale, dateIso, date: formatDocumentDate(dateIso, locale), tocTitle: tocTitleFor(locale), captionLabels: captionLabelsFor(locale) }
}
