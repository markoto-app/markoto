import type { Skill } from './skill'
import { academicPaperSkill } from './academicPaper'
import { longDocumentSkill } from './longDocument'
import { reviewSkill } from './review'
import { translationSkill } from './translation'

// Built-in skills: task guidance kept out of the static prompt. The static
// prompt carries only the catalogue (one line per skill, sorted by id, built
// once at module load, so it changes only with a release). A body reaches the
// model in one of two ways, neither of which touches the cached prefix
// (system message + tools):
//   - preselected on the server from the user's request and the document
//     size, as `<skill id="...">` blocks in the first user message
//     (`initialUserParts`, after the per-document context, before memory);
//   - loaded by the model with the `load_skill` tool, as a tool result.
// Never vary the system prompt per session to add guidance.

/** Every skill, sorted by id: the catalogue order and the `load_skill` enum. */
export const SKILLS = [academicPaperSkill, longDocumentSkill, reviewSkill, translationSkill] as const

export type SkillId = typeof SKILLS[number]['id']

export const SKILL_IDS = SKILLS.map(s => s.id) as [SkillId, ...SkillId[]]

const SKILLS_BY_ID: ReadonlyMap<string, Skill> = new Map(SKILLS.map(s => [s.id, s]))

export function findSkill(id: string): Skill | undefined {
  return SKILLS_BY_ID.get(id)
}

/** The catalogue section of both static prompts. */
export const SKILL_CATALOGUE = `SKILLS (task guides; call \`load_skill\` with the id when the task matches; a \`<skill id="...">\` block in the user message is already loaded, follow it without loading it again):
${SKILLS.map(s => `- ${s.id}: ${s.when}`).join('\n')}`

/** A skill body as the model sees it, preselected or loaded. */
export function skillBlock(skill: Skill): string {
  return `<skill id="${skill.id}">\n${skill.body}\n</skill>`
}

// ── Server-side preselection ──
// A cheap keyword classifier over what the user typed (en / de / fr / es,
// plus words shared with it / pt) and the document size. It saves the
// `load_skill` turn when the task is obvious; a miss only costs that turn.

/** Same threshold as the outline's `delegate_hint` (`sectionTools.ts`). */
export const LONG_DOCUMENT_TOKENS = 12_000
/** "Throughout the document" on a short document needs no long-document guidance. */
const WHOLE_DOCUMENT_MIN_TOKENS = 2_000
/** At most this many bodies go into the first user message. */
const MAX_PRESELECTED = 2

/**
 * Matches any of the stems at the start of a word. JavaScript's `\b` only
 * knows ASCII word characters, so it would fail before "Übersetze"; a
 * Unicode lookbehind does not.
 */
function stems(...words: string[]): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- built once at module load from the constant word lists below
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})`, 'iu')
}

const TASK_TRIGGERS: ReadonlyArray<{ id: SkillId, pattern: RegExp }> = [
  {
    id: 'translation',
    // translate / übersetzen / traduire, traduis / traducir, traduce / tradurre / traduzir
    pattern: stems('translat', 'übersetz', 'tradu')
  },
  {
    id: 'review',
    pattern: stems(
      'review', 'proofread', 'critique', 'feedback', 'comment',
      'prüf', 'überprüf', 'korrektur', 'lektor', 'begutacht', 'kommentier', 'anmerkung',
      'relis', 'relire', 'relecture', 'révis',
      // not 'revis': English "revise" asks for an edit, not a review
      'revisa', 'revisión', 'revisiones', 'comentar', 'comentario'
    )
  },
  {
    id: 'academic-paper',
    pattern: stems(
      'abstract', 'citation', 'cite', 'citing', 'paper', 'thesis', 'dissertation', 'bibliograph', 'peer[- ]review',
      'zitat', 'zitier', 'literaturverzeichnis', 'fachartikel', 'wissenschaftlich', 'bachelorarbeit', 'masterarbeit', 'doktorarbeit',
      'article scientifique', 'thèse',
      'cita[sr]?(?![\\p{L}])', 'citación', 'artículo científico', 'tesis'
    )
  }
]

const WHOLE_DOCUMENT = stems(
  'whole (?:document|text|paper)', 'entire (?:document|text|paper)', 'throughout', 'everywhere', 'every (?:section|chapter|paragraph)', 'all (?:sections|chapters|paragraphs)',
  'überall', 'ganze[nmrs]? (?:dokument|text)', 'gesamte[nmrs]? (?:dokument|text)', 'durchgehend', 'jede[nmrs]? (?:abschnitt|kapitel)', 'alle[n]? (?:abschnitte|kapitel)',
  'tout le (?:document|texte)', 'partout', 'l\'ensemble du (?:document|texte)', 'chaque (?:section|chapitre|paragraphe)', 'toutes les sections', 'tous les chapitres',
  'todo el (?:documento|texto)', 'documento completo', 'en todas partes', 'cada (?:sección|capítulo|párrafo)', 'todas las secciones', 'todos los capítulos'
)

export interface SkillSelectionInput {
  /** What the user typed (prompt bar text, or the triggering comment). */
  request: string
  /** Estimated tokens of the whole document (`parseSectionsCached(...).totals.tokens`). */
  documentTokens: number
}

/**
 * At most two skills for this request, most specific first: the first
 * matching task skill, then `long-document` when the document is large (or
 * the request spans the whole of a not-tiny document), then further task
 * skills while there is room.
 */
export function preselectSkills({ request, documentTokens }: SkillSelectionInput): SkillId[] {
  const tasks = TASK_TRIGGERS.filter(t => t.pattern.test(request)).map(t => t.id)
  const long = documentTokens > LONG_DOCUMENT_TOKENS
    || (documentTokens >= WHOLE_DOCUMENT_MIN_TOKENS && WHOLE_DOCUMENT.test(request))
  const ordered: SkillId[] = [...tasks.slice(0, 1), ...(long ? ['long-document' as const] : []), ...tasks.slice(1)]
  return ordered.slice(0, MAX_PRESELECTED)
}

/** The preselected skill bodies for the first user message; '' when none applies. */
export function preselectedSkillsBlock(input: SkillSelectionInput): string {
  return preselectSkills(input)
    .map(id => skillBlock(findSkill(id) as Skill))
    .join('\n\n')
}
