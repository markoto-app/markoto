/**
 * Document templates registry. Each template is a structural skeleton
 * the user picks at creation time: heading hierarchy + section-level
 * `<!-- ... -->` comments instructing the writer (or the AI) what
 * belongs where.
 *
 * THIS FILE = registry only (id, icon, i18n keys). The actual markdown
 * bodies live in `content/<id>/<locale>.md` and are loaded server-side
 * by `server/utils/templateRenderer.ts` (via fs.readFileSync). The
 * client never touches the body files — the server pre-renders the
 * template and ships the result on the token endpoint.
 *
 * Why the split: Vite handles `import x from './x.md?raw'` for the
 * client bundle, but Nitro's rollup pipeline does not, so a unified
 * shared/ import would break SSR. Keeping the registry import-safe
 * for both sides is worth the small coordination cost when adding a
 * template (touch two places: this list + drop the .md files).
 *
 * Adding a template:
 *   1. Drop `content/<id>/en.md` (mandatory) + any other locales.
 *   2. Add an entry to TEMPLATES below — id, icon, hasContent flag.
 *   3. Add i18n keys: `templates.<id>.label` + `.description`
 *      in every locale json.
 *
 * Adding a locale to an existing template: drop the .md file. No
 * registry change — the renderer auto-discovers it.
 */

export interface TemplateMeta {
  /** Stable id stored in `documents.templateId`. Never rename. */
  id: string
  /** Lucide icon name shown in the picker. */
  icon: string
  /** i18n keys (resolved client-side via t()). */
  labelKey: string
  descriptionKey: string
  /**
   * False for `blank` (an empty document), true for everything else.
   * Lets the dialog branch on whether the template adds content
   * vs. just sets metadata.
   */
  hasContent: boolean
}

export const TEMPLATES: TemplateMeta[] = [
  // The guided tour of markdown + markoto's features; the new-document
  // dialog's default (DEFAULT_TEMPLATE_ID). `blank` is truly empty.
  { id: 'demo', icon: 'i-lucide-compass', labelKey: 'templates.demo.label', descriptionKey: 'templates.demo.description', hasContent: true },
  { id: 'blank', icon: 'i-lucide-file', labelKey: 'templates.blank.label', descriptionKey: 'templates.blank.description', hasContent: false },
  { id: 'business-plan', icon: 'i-lucide-briefcase', labelKey: 'templates.business-plan.label', descriptionKey: 'templates.business-plan.description', hasContent: true },
  { id: 'academic-paper', icon: 'i-lucide-graduation-cap', labelKey: 'templates.academic-paper.label', descriptionKey: 'templates.academic-paper.description', hasContent: true },
  { id: 'recipe', icon: 'i-lucide-utensils', labelKey: 'templates.recipe.label', descriptionKey: 'templates.recipe.description', hasContent: true },
  { id: 'meeting-notes', icon: 'i-lucide-users', labelKey: 'templates.meeting-notes.label', descriptionKey: 'templates.meeting-notes.description', hasContent: true },
  { id: 'project-readme', icon: 'i-lucide-book-open', labelKey: 'templates.project-readme.label', descriptionKey: 'templates.project-readme.description', hasContent: true }
]

export const TEMPLATE_IDS = TEMPLATES.map(t => t.id)

/** What the new-document dialog pre-selects. The API's own default (an
 *  empty POST /api/docs) stays `blank`: an empty document. */
export const DEFAULT_TEMPLATE_ID = 'demo'

export function isTemplateId(value: unknown): value is string {
  return typeof value === 'string' && TEMPLATE_IDS.includes(value)
}

export function getTemplate(id: string): TemplateMeta | null {
  return TEMPLATES.find(t => t.id === id) ?? null
}

/** Locales the renderer can match. Add an entry here when shipping
 *  a new locale's .md files across multiple templates. The renderer
 *  also accepts arbitrary strings — non-listed values fall back to en.
 */
export const TEMPLATE_LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
export type TemplateLocale = typeof TEMPLATE_LOCALES[number]
