import type { CrossrefKind } from './citeSyntax'

/**
 * Words cross-references print, per document language: "Figure 3",
 * "Abbildung 3", "Tables 1 and 2". Capitalised everywhere: a reference
 * names a numbered object. Languages without an entry use English.
 */
type Forms = Readonly<Record<CrossrefKind, readonly [string, string]>>

const WORDS: Record<string, { forms: Forms, and: string }> = {
  en: { forms: { fig: ['Figure', 'Figures'], tbl: ['Table', 'Tables'], eq: ['Equation', 'Equations'], sec: ['Section', 'Sections'] }, and: 'and' },
  de: { forms: { fig: ['Abbildung', 'Abbildungen'], tbl: ['Tabelle', 'Tabellen'], eq: ['Gleichung', 'Gleichungen'], sec: ['Abschnitt', 'Abschnitte'] }, and: 'und' },
  fr: { forms: { fig: ['Figure', 'Figures'], tbl: ['Tableau', 'Tableaux'], eq: ['Équation', 'Équations'], sec: ['Section', 'Sections'] }, and: 'et' },
  es: { forms: { fig: ['Figura', 'Figuras'], tbl: ['Tabla', 'Tablas'], eq: ['Ecuación', 'Ecuaciones'], sec: ['Sección', 'Secciones'] }, and: 'y' },
  it: { forms: { fig: ['Figura', 'Figure'], tbl: ['Tabella', 'Tabelle'], eq: ['Equazione', 'Equazioni'], sec: ['Sezione', 'Sezioni'] }, and: 'e' },
  pt: { forms: { fig: ['Figura', 'Figuras'], tbl: ['Tabela', 'Tabelas'], eq: ['Equação', 'Equações'], sec: ['Secção', 'Secções'] }, and: 'e' },
  nl: { forms: { fig: ['Figuur', 'Figuren'], tbl: ['Tabel', 'Tabellen'], eq: ['Vergelijking', 'Vergelijkingen'], sec: ['Sectie', 'Secties'] }, and: 'en' },
  ja: { forms: { fig: ['図', '図'], tbl: ['表', '表'], eq: ['式', '式'], sec: ['節', '節'] }, and: '・' },
  zh: { forms: { fig: ['图', '图'], tbl: ['表', '表'], eq: ['式', '式'], sec: ['节', '节'] }, and: '、' }
}

function wordsFor(locale: string) {
  return WORDS[(locale.split('-')[0] ?? 'en').toLowerCase()] ?? WORDS.en!
}

/** Whether the language writes the number without a space after the word (CJK). */
function tight(locale: string): boolean {
  return /^(?:ja|zh)\b/i.test(locale)
}

/** "Figure 3" / "Figures 2 and 3" / "Equation (4)". `numbers` as printed (equations already in parentheses). */
export function crossrefText(kind: CrossrefKind, numbers: readonly string[], locale: string, captionWord?: string): string {
  const { forms, and } = wordsFor(locale)
  // A language without its own words here: the caption label the theme prints ("Rysunek") for both forms.
  const known = (locale.split('-')[0] ?? 'en').toLowerCase() in WORDS
  const [one, many] = !known && captionWord ? [captionWord, captionWord] : forms[kind]
  const sep = tight(locale) ? '' : ' '
  if (numbers.length <= 1) return `${one}${sep}${numbers[0] ?? ''}`
  const list = numbers.length === 2
    ? `${numbers[0]} ${and} ${numbers[1]}`
    : `${numbers.slice(0, -1).join(', ')} ${and} ${numbers.at(-1)}`
  return `${many}${sep}${list}`
}

/** "Figure" / "Abbildung": the label word for captions injected by the resolver. */
export function crossrefWord(kind: CrossrefKind, locale: string): string {
  return wordsFor(locale).forms[kind][0]
}

/** List-of-figures / list-of-tables heading. */
const LIST_TITLES: Record<string, readonly [string, string]> = {
  en: ['List of Figures', 'List of Tables'],
  de: ['Abbildungsverzeichnis', 'Tabellenverzeichnis'],
  fr: ['Table des figures', 'Liste des tableaux'],
  es: ['Índice de figuras', 'Índice de tablas'],
  it: ['Elenco delle figure', 'Elenco delle tabelle'],
  pt: ['Lista de figuras', 'Lista de tabelas'],
  nl: ['Lijst van figuren', 'Lijst van tabellen'],
  ja: ['図目次', '表目次'],
  zh: ['图目录', '表目录']
}

export function listTitle(kind: 'lof' | 'lot', locale: string): string {
  const titles = LIST_TITLES[(locale.split('-')[0] ?? 'en').toLowerCase()] ?? LIST_TITLES.en!
  return kind === 'lof' ? titles[0] : titles[1]
}

/** Element id for a label (`fig:overview` → `xref-fig-overview`): no `:`, which paged.js `target-counter` would read as a selector. */
export function crossrefAnchorId(label: string): string {
  return `xref-${label.replace(/[^\p{L}\p{N}_-]/gu, '-')}`
}

/** Element id of a bibliography entry. */
export function referenceAnchorId(key: string): string {
  return `ref-${key.replace(/[^\p{L}\p{N}_-]/gu, '-')}`
}
