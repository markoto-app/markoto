/**
 * Document templates registry. A template is a bundle: a starting text
 * (a structural skeleton: heading hierarchy + section-level `<!-- ... -->`
 * comments telling the writer, or the AI, what belongs where) together with
 * the design it is written for (a built-in theme preset). The new-document
 * dialog offers the bundles as ONE choice; the design can be changed later
 * in the editor's theme panel.
 *
 * THIS FILE = registry only (id, design, category, icon, i18n keys, cover
 * placeholders). The markdown bodies live in `content/<content>/<locale>.md`
 * and are loaded server-side by `server/utils/documents/templateRenderer.ts` (via
 * fs.readFileSync). The client never touches the body files, the server
 * pre-renders the template and ships the result on the token endpoint.
 *
 * Why the split: Vite handles `import x from './x.md?raw'` for the
 * client bundle, but Nitro's rollup pipeline does not, so a unified
 * shared/ import would break SSR.
 *
 * Adding a template:
 *   1. Drop `content/<id>/en.md` + `de.md` (both mandatory; more locales
 *      optional, a missing one falls back to English).
 *   2. Add an entry to TEMPLATES below, id, design, category, icon.
 *   3. Add i18n keys `templates.<id>.label` + `.description` in every
 *      locale json.
 *   4. Render its picture (`make template-thumbs IDS=<id>`), with a sample
 *      title in `tests/fixtures/theme-shots/template-thumbs.json`.
 */
import type { ThemePresetCategory } from '../utils/theme/themePresets'

/** Cover fields a template fills in for its design (the theme's cover
 *  carries authors, affiliations and subtitle, not the text). Only applied
 *  when the document gets the template's own design. */
export interface TemplateCoverPlaceholders {
  subtitle?: string
  authors?: string[]
  affiliations?: string[]
  /** The text carries the date itself (a newsletter's issue line). */
  showDate?: boolean
}

export interface TemplateMeta {
  /** Stable id stored in `documents.templateId`. Never rename (add an alias). */
  id: string
  /** Directory of the body files under `content/`. */
  content: string
  /**
   * Built-in theme preset the text is written for. `null` = no design of
   * its own (Blank): the document gets the user's default design, the
   * workspace default, else the markoto preset.
   */
  design: string | null
  /** Tab in the dialog's picker (`general` shows only under All). */
  category: ThemePresetCategory
  /** Lucide icon (kept for lists without a picture). */
  icon: string
  /** i18n keys (resolved client-side via t()). */
  labelKey: string
  descriptionKey: string
  /** False for `blank` (an empty document), true for everything else. */
  hasContent: boolean
  /** Per template locale; a missing locale falls back to `en`. */
  cover?: Partial<Record<TemplateLocale, TemplateCoverPlaceholders>>
}

/** Locales the renderer can match. The renderer also accepts arbitrary
 *  strings: non-listed values fall back to en. */
export const TEMPLATE_LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
export type TemplateLocale = typeof TEMPLATE_LOCALES[number]

function template(
  id: string,
  design: string | null,
  category: ThemePresetCategory,
  icon: string,
  extra: { content?: string, cover?: TemplateMeta['cover'] } = {}
): TemplateMeta {
  return {
    id,
    content: extra.content ?? id,
    design,
    category,
    icon,
    labelKey: `templates.${id}.label`,
    descriptionKey: `templates.${id}.description`,
    hasContent: id !== 'blank',
    ...(extra.cover ? { cover: extra.cover } : {})
  }
}

const YOUR_NAME = { en: 'Your Name', de: 'Dein Name' }
const IEEE_AFFILIATION = { en: 'Department\nInstitution\nCity, Country\nname@example.org', de: 'Institut\nHochschule\nOrt, Land\nname@example.org' }

export const TEMPLATES: TemplateMeta[] = [
  // General: the guided tour (the dialog's default for a first document),
  // an empty page, a filled-in one-page CV for a made-up person.
  template('demo', 'markoto', 'general', 'i-lucide-compass'),
  template('blank', null, 'general', 'i-lucide-file'),
  template('resume', 'resume', 'general', 'i-lucide-id-card'),

  // Engineering
  template('runbook', 'runbook', 'engineering', 'i-lucide-siren', {
    cover: {
      en: { subtitle: 'service-a · service-b · service-c', authors: ['Team name'] },
      de: { subtitle: 'service-a · service-b · service-c', authors: ['Name des Teams'] }
    }
  }),
  template('design-doc', 'design-doc', 'engineering', 'i-lucide-drafting-compass', {
    cover: {
      en: { subtitle: 'Team name · Design doc' },
      de: { subtitle: 'Teamname · Designdokument' }
    }
  }),
  template('api-reference', 'api-reference', 'engineering', 'i-lucide-braces', {
    cover: {
      en: { subtitle: 'API version 1' },
      de: { subtitle: 'API-Version 1' }
    }
  }),
  template('project-readme', 'tech-docs', 'engineering', 'i-lucide-book-open', {
    cover: {
      en: { subtitle: 'One-line tagline', authors: ['The project maintainers'] },
      de: { subtitle: 'Kurzbeschreibung in einer Zeile', authors: ['Die Maintainer des Projekts'] }
    }
  }),

  // Academic
  template('arxiv', 'arxiv', 'academic', 'i-lucide-graduation-cap', {
    cover: {
      en: { authors: [YOUR_NAME.en, 'Co-author Name'], affiliations: ['Department, Institution\nCity, Country\nname@example.org', 'Department, Institution\nCity, Country\nname@example.org'] },
      de: { authors: [YOUR_NAME.de, 'Name Koautorin'], affiliations: ['Institut, Hochschule\nOrt, Land\nname@example.org', 'Institut, Hochschule\nOrt, Land\nname@example.org'] }
    }
  }),
  template('ieee-conference', 'ieee-conference', 'academic', 'i-lucide-presentation', {
    cover: {
      en: { authors: ['First Author', 'Second Author', 'Third Author'], affiliations: [IEEE_AFFILIATION.en, IEEE_AFFILIATION.en, IEEE_AFFILIATION.en] },
      de: { authors: ['Erste Autorin', 'Zweiter Autor', 'Dritte Autorin'], affiliations: [IEEE_AFFILIATION.de, IEEE_AFFILIATION.de, IEEE_AFFILIATION.de] }
    }
  }),
  template('thesis', 'thesis', 'academic', 'i-lucide-library', {
    cover: {
      en: { subtitle: 'Master’s thesis, Department of Field', authors: [YOUR_NAME.en], affiliations: ['Department, University\nCity, Country'] },
      de: { subtitle: 'Masterarbeit, Institut für Fachgebiet', authors: [YOUR_NAME.de], affiliations: ['Institut, Universität\nOrt, Land'] }
    }
  }),
  template('lecture-notes', 'lecture-notes', 'academic', 'i-lucide-notebook-pen', {
    cover: {
      en: { subtitle: 'Course code · Semester', authors: ['Lecturer Name'] },
      de: { subtitle: 'Kursnummer · Semester', authors: ['Name der Dozentin'] }
    }
  }),
  template('essay', 'essay', 'academic', 'i-lucide-pen-line', {
    cover: {
      en: { authors: [YOUR_NAME.en], affiliations: ['Department, University\nCOURSE 1234: Course Name\nInstructor Name'] },
      de: { authors: [YOUR_NAME.de], affiliations: ['Institut, Universität\nKURS 1234: Name der Lehrveranstaltung\nName der Dozentin'] }
    }
  }),

  // Business
  template('report', 'business-report', 'business', 'i-lucide-chart-column', {
    cover: {
      en: { subtitle: 'Quarterly report', authors: ['Organisation name'] },
      de: { subtitle: 'Quartalsbericht', authors: ['Name der Organisation'] }
    }
  }),
  template('business-plan', 'business-report', 'business', 'i-lucide-briefcase', {
    cover: {
      en: { subtitle: 'Business plan', authors: ['Company name'] },
      de: { subtitle: 'Businessplan', authors: ['Firmenname'] }
    }
  }),
  template('proposal', 'proposal', 'business', 'i-lucide-handshake', {
    cover: {
      en: { subtitle: 'Prepared for Client name', authors: ['Your company'] },
      de: { subtitle: 'Erstellt für Kundenname', authors: ['Deine Firma'] }
    }
  }),
  template('one-pager', 'one-pager', 'business', 'i-lucide-file-badge', {
    cover: {
      en: { subtitle: 'Product one-pager' },
      de: { subtitle: 'Produkt-Onepager' }
    }
  }),
  template('memo', 'memo', 'business', 'i-lucide-mail'),
  template('meeting-notes', 'modern', 'business', 'i-lucide-users'),

  // Writing
  template('manuscript', 'manuscript', 'writing', 'i-lucide-book-marked', {
    cover: {
      en: { subtitle: 'A novel', authors: [YOUR_NAME.en] },
      de: { subtitle: 'Roman', authors: [YOUR_NAME.de] }
    }
  }),
  template('newsletter', 'newsletter', 'writing', 'i-lucide-newspaper', {
    cover: {
      en: { subtitle: 'Newsletter of Organisation name', showDate: false },
      de: { subtitle: 'Newsletter von Name der Organisation', showDate: false }
    }
  }),
  template('recipe', 'modern', 'writing', 'i-lucide-utensils')
]

export const TEMPLATE_IDS = TEMPLATES.map(t => t.id)

/**
 * Retired ids still stored on older documents (and in old links): the
 * template they became. `academic-paper` was folded into the arXiv
 * preprint template.
 */
const TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  'academic-paper': 'arxiv'
}

/** What the new-document dialog pre-selects for a first document. The
 *  API's own default (an empty POST /api/docs) stays `blank`. */
export const DEFAULT_TEMPLATE_ID = 'demo'

/** Registered id or alias → registered id; anything else → null. */
export function resolveTemplateId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (TEMPLATE_IDS.includes(value)) return value
  const alias = TEMPLATE_ALIASES[value]
  return alias !== undefined && TEMPLATE_IDS.includes(alias) ? alias : null
}

/** A registered id or an alias of one. */
export function isTemplateId(value: unknown): value is string {
  return resolveTemplateId(value) !== null
}

/** Meta of a registered id or alias. */
export function getTemplate(id: string): TemplateMeta | null {
  const resolved = resolveTemplateId(id)
  return resolved === null ? null : TEMPLATES.find(t => t.id === resolved) ?? null
}

/**
 * The doc's language string → a template locale. ISO codes match
 * directly; BCP-47 region tags are stripped (`de-CH` → `de`); free-text
 * values fall back to English.
 */
export function templateLocale(language: string): TemplateLocale {
  for (const candidate of [language, language.split('-')[0]?.toLowerCase() ?? '']) {
    const match = TEMPLATE_LOCALES.find(l => l === candidate)
    if (match) return match
  }
  return 'en'
}

/** Cover placeholders of a template in a document language (en fallback). */
export function templateCover(meta: TemplateMeta, language: string): TemplateCoverPlaceholders | null {
  if (!meta.cover) return null
  return meta.cover[templateLocale(language)] ?? meta.cover.en ?? null
}

/**
 * One line for the AI / MCP `create_document` tool: every template id
 * with the design it brings ("runbook (design: runbook), blank (no design
 * of its own), …").
 */
export const TEMPLATE_TOOL_HINT = TEMPLATES
  .map(t => t.design ? `${t.id} (design: ${t.design})` : `${t.id} (no design of its own)`)
  .join(', ')
