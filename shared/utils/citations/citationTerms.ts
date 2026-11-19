import type { LocatorLabel } from './citeSyntax'

/**
 * Words citations and the bibliography print, per document language
 * (`ymeta.language`, like caption labels and dates). Languages without a
 * table here use English. DIN 1505-2 is a German standard and always
 * uses the German terms.
 */
export interface CitationTerms {
  and: string
  etAl: string
  noDate: string
  locators: Record<LocatorLabel, readonly [string, string]>
  /** Short editor role after names: "ed." / "eds.". */
  editor: readonly [string, string]
  /** "edited by" before names (Chicago). */
  editedBy: string
  /** Edition abbreviation after the ordinal ("2nd ed."). */
  edition: string
  in: string
  volume: string
  issue: string
  availableAt: string
  accessed: string
  doctoralThesis: string
  mastersThesis: string
  report: string
  /** Default heading of a generated bibliography. */
  references: string
  ordinal: (n: number) => string
}

const EN: CitationTerms = {
  and: 'and',
  etAl: 'et al.',
  noDate: 'n.d.',
  locators: {
    page: ['p.', 'pp.'], chapter: ['chap.', 'chaps.'], section: ['sec.', 'secs.'], paragraph: ['para.', 'paras.'],
    figure: ['fig.', 'figs.'], volume: ['vol.', 'vols.'], line: ['l.', 'll.'], note: ['n.', 'nn.'], column: ['col.', 'cols.']
  },
  editor: ['ed.', 'eds.'],
  editedBy: 'edited by',
  edition: 'ed.',
  in: 'In',
  volume: 'vol.',
  issue: 'no.',
  availableAt: 'Available at',
  accessed: 'Accessed',
  doctoralThesis: 'Doctoral dissertation',
  mastersThesis: 'Master\'s thesis',
  report: 'Report',
  references: 'References',
  ordinal: (n) => {
    const t = n % 100
    const s = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
    return `${n}${s}`
  }
}

const DE: CitationTerms = {
  and: 'und',
  etAl: 'et al.',
  noDate: 'o. J.',
  locators: {
    page: ['S.', 'S.'], chapter: ['Kap.', 'Kap.'], section: ['Abschn.', 'Abschn.'], paragraph: ['Abs.', 'Abs.'],
    figure: ['Abb.', 'Abb.'], volume: ['Bd.', 'Bd.'], line: ['Z.', 'Z.'], note: ['Anm.', 'Anm.'], column: ['Sp.', 'Sp.']
  },
  editor: ['Hrsg.', 'Hrsg.'],
  editedBy: 'hrsg. von',
  edition: 'Aufl.',
  in: 'In',
  volume: 'Bd.',
  issue: 'Nr.',
  availableAt: 'Verfügbar unter',
  accessed: 'Abgerufen am',
  doctoralThesis: 'Dissertation',
  mastersThesis: 'Masterarbeit',
  report: 'Bericht',
  references: 'Literatur',
  ordinal: n => `${n}.`
}

const FR: CitationTerms = {
  ...EN,
  and: 'et',
  noDate: 's. d.',
  locators: {
    page: ['p.', 'p.'], chapter: ['chap.', 'chap.'], section: ['sect.', 'sect.'], paragraph: ['par.', 'par.'],
    figure: ['fig.', 'fig.'], volume: ['vol.', 'vol.'], line: ['l.', 'l.'], note: ['n.', 'n.'], column: ['col.', 'col.']
  },
  editor: ['éd.', 'éds.'],
  editedBy: 'sous la direction de',
  edition: 'éd.',
  in: 'In',
  issue: 'nº',
  availableAt: 'Disponible sur',
  accessed: 'Consulté le',
  doctoralThesis: 'Thèse de doctorat',
  mastersThesis: 'Mémoire de master',
  report: 'Rapport',
  references: 'Références',
  ordinal: n => (n === 1 ? '1re' : `${n}e`)
}

const ES: CitationTerms = {
  ...EN,
  and: 'y',
  noDate: 's. f.',
  locators: {
    page: ['p.', 'pp.'], chapter: ['cap.', 'caps.'], section: ['sec.', 'secs.'], paragraph: ['párr.', 'párrs.'],
    figure: ['fig.', 'figs.'], volume: ['vol.', 'vols.'], line: ['l.', 'll.'], note: ['n.', 'nn.'], column: ['col.', 'cols.']
  },
  editor: ['ed.', 'eds.'],
  editedBy: 'editado por',
  edition: 'ed.',
  in: 'En',
  issue: 'n.º',
  availableAt: 'Disponible en',
  accessed: 'Consultado el',
  doctoralThesis: 'Tesis doctoral',
  mastersThesis: 'Tesis de maestría',
  report: 'Informe',
  references: 'Referencias',
  ordinal: n => `${n}.ª`
}

const IT: CitationTerms = {
  ...EN,
  and: 'e',
  noDate: 's.d.',
  editor: ['a cura di', 'a cura di'],
  editedBy: 'a cura di',
  edition: 'ed.',
  issue: 'n.',
  availableAt: 'Disponibile su',
  accessed: 'Consultato il',
  doctoralThesis: 'Tesi di dottorato',
  mastersThesis: 'Tesi di laurea magistrale',
  report: 'Rapporto',
  references: 'Bibliografia',
  ordinal: n => `${n}ª`
}

const TERMS: Record<string, CitationTerms> = { en: EN, de: DE, fr: FR, es: ES, it: IT }

/** Terms for a BCP-47 locale (`de-CH` → German). */
export function citationTerms(locale: string): CitationTerms {
  return TERMS[(locale.split('-')[0] ?? 'en').toLowerCase()] ?? EN
}

/** Heading of a generated bibliography in the document language (more languages than the full term tables). */
const REFERENCES_HEADINGS: Record<string, string> = {
  en: 'References', de: 'Literatur', fr: 'Références', es: 'Referencias', it: 'Bibliografia',
  pt: 'Referências', nl: 'Literatuur', pl: 'Bibliografia', sv: 'Referenser', da: 'Litteratur',
  nb: 'Litteratur', no: 'Litteratur', fi: 'Lähteet', cs: 'Literatura', rm: 'Litteratura', ja: '参考文献', zh: '参考文献'
}

export function referencesHeading(locale: string): string {
  return REFERENCES_HEADINGS[(locale.split('-')[0] ?? 'en').toLowerCase()] ?? 'References'
}
