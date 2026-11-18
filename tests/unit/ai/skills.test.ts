import { describe, it, expect } from 'vitest'
import {
  findSkill,
  LONG_DOCUMENT_TOKENS,
  preselectedSkillsBlock,
  preselectSkills,
  SKILL_CATALOGUE,
  SKILL_IDS,
  SKILLS
} from '../../../server/utils/agentic/skills'
import { PROMPT_SYSTEM_PROMPT } from '../../../server/utils/agentic/promptAssembly'
import { COMMENT_TRIGGER_SYSTEM_PROMPT } from '../../../server/utils/agentic/commentTriggerPrompt'
import { TASK_PLAYBOOK } from '../../../server/utils/agentic/taskPlaybook'
import { describeToolInput } from '../../../server/utils/agentic/streamStatus'
import { shouldRecordToolInMemory } from '../../../server/utils/agentic/conversationMemory'
import { executeFunctionByName, SESSION_TOOL_CALL_CAPS, toolSchema } from '../../../server/utils/ai/tools/registry'
import type { DocToolContext } from '../../../server/utils/agentic/toolContext'

const EM_DASH = '\u2014'
/** The bench's estimate (`tests/bench/ai/report.ts`): characters / 3.6. */
const tokens = (s: string) => Math.round(s.length / 3.6)

describe('skill catalogue', () => {
  it('is pinned byte for byte (part of the cached prefix: change it only on purpose)', () => {
    expect(SKILL_CATALOGUE).toBe(`SKILLS (task guides; call \`load_skill\` with the id when the task matches; a \`<skill id="...">\` block in the user message is already loaded, follow it without loading it again):
- academic-paper: papers and theses: abstract, citations, figure and table numbering
- long-document: large documents, changes across the whole document
- review: reviewing, proofreading or giving feedback as comments
- translation: translating text into another language`)
  })

  it('lists the skills sorted by id, one line each', () => {
    const ids = SKILLS.map(s => s.id)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
    expect(SKILL_IDS).toEqual(ids)
    for (const s of SKILLS) expect(s.when).not.toMatch(/\n/)
  })

  it('is in both static prompts; the playbook only in the editor prompt', () => {
    expect(PROMPT_SYSTEM_PROMPT).toContain(SKILL_CATALOGUE)
    expect(COMMENT_TRIGGER_SYSTEM_PROMPT).toContain(SKILL_CATALOGUE)
    expect(PROMPT_SYSTEM_PROMPT).toContain(TASK_PLAYBOOK)
    // No skill body is in a static prompt.
    for (const s of SKILLS) {
      expect(PROMPT_SYSTEM_PROMPT).not.toContain(s.body)
      expect(COMMENT_TRIGGER_SYSTEM_PROMPT).not.toContain(s.body)
    }
  })

  it('catalogue + playbook stay small (every call sends them)', () => {
    expect(tokens(SKILL_CATALOGUE) + tokens(TASK_PLAYBOOK)).toBeLessThan(650)
  })
})

describe('skill bodies', () => {
  it.each(SKILLS.map(s => [s.id, s] as const))('%s: no em-dash, concise', (_id, skill) => {
    expect(skill.body).not.toContain(EM_DASH)
    expect(skill.title).not.toContain(EM_DASH)
    expect(skill.when).not.toContain(EM_DASH)
    expect(tokens(skill.body)).toBeGreaterThan(250)
    expect(tokens(skill.body)).toBeLessThan(650)
  })
})

describe('skill preselection', () => {
  const small = 800
  const pick = (request: string, documentTokens = small) => preselectSkills({ request, documentTokens })

  it.each([
    ['Translate this section into French', 'en'],
    ['Übersetze das Dokument ins Englische', 'de'],
    ['übersetze bitte den Absatz', 'de, lower case umlaut at the start'],
    ['Traduis ce paragraphe en allemand', 'fr'],
    ['Traduce este capítulo al inglés', 'es'],
    ['Traduci il testo in tedesco', 'it']
  ])('translation: %s (%s)', (request) => {
    expect(pick(request)).toEqual(['translation'])
  })

  it.each([
    ['Review chapter 3 and leave comments'],
    ['Please proofread the introduction'],
    ['Prüfe den Text auf Fehler'],
    ['Kannst du das Kapitel überprüfen?'],
    ['Relis ce chapitre et commente'],
    ['Révise la conclusion'],
    ['Revisa el texto y comenta los problemas'],
    ['Give me feedback on the argument']
  ])('review: %s', (request) => {
    expect(pick(request)).toEqual(['review'])
  })

  it.each([
    ['Write an abstract for this paper'],
    ['Fix the citations in section 2'],
    ['Prüfe die Zitate'],
    ['Formatiere das Literaturverzeichnis'],
    ['Ajoute une citation pour cette phrase'],
    ['Añade las citas que faltan en la tesis']
  ])('academic-paper: %s', (request) => {
    expect(pick(request)).toContain('academic-paper')
  })

  it('English "revise" asks for an edit, not a review', () => {
    expect(pick('Revise the intro to be shorter')).toEqual([])
  })

  it('an ordinary request picks nothing', () => {
    expect(pick('Add a table with the prices')).toEqual([])
    expect(pick('Make the heading bold')).toEqual([])
    expect(pick('')).toEqual([])
  })

  it('a large document adds long-document after the task skill', () => {
    expect(pick('Fix the typo in line 3', LONG_DOCUMENT_TOKENS + 1)).toEqual(['long-document'])
    expect(pick('Translate it into English', 170_000)).toEqual(['translation', 'long-document'])
    expect(pick('Fix the typo in line 3', LONG_DOCUMENT_TOKENS)).toEqual([])
  })

  it.each([
    ['Use the formal tone throughout'],
    ['Replace "client" everywhere'],
    ['Ändere die Anrede im ganzen Dokument'],
    ['Überall Sie statt du'],
    ['Corrige les fautes dans tout le document'],
    ['Cambia el tono en todo el documento']
  ])('"whole document" phrasing on a mid-sized document: %s', (request) => {
    expect(pick(request, 5_000)).toEqual(['long-document'])
    // ...but not on a short one.
    expect(pick(request, 500)).toEqual([])
  })

  it('picks at most two skills', () => {
    const all = pick('Review the translation of the abstract and the citations throughout', 200_000)
    expect(all).toHaveLength(2)
    expect(all).toEqual(['translation', 'long-document'])
    expect(pick('Review the translation of the citations')).toEqual(['translation', 'review'])
  })

  it('renders the bodies as <skill> blocks, empty when nothing applies', () => {
    expect(preselectedSkillsBlock({ request: 'Add a table', documentTokens: small })).toBe('')
    const block = preselectedSkillsBlock({ request: 'Translate this', documentTokens: 50_000 })
    expect(block).toBe(`<skill id="translation">\n${findSkill('translation')?.body}\n</skill>\n\n<skill id="long-document">\n${findSkill('long-document')?.body}\n</skill>`)
  })
})

describe('load_skill tool', () => {
  // load_skill is a meta tool that reads nothing from its context.
  const ctx = Object.create(null) as DocToolContext

  it('returns the body as a <skill> block', async () => {
    const result = await executeFunctionByName(ctx, 'load_skill', { id: 'review' })
    expect(result.isError).toBe(false)
    expect(result.content).toBe(`<skill id="review">\n${findSkill('review')?.body}\n</skill>`)
  })

  it('accepts only known ids', () => {
    const schema = toolSchema('load_skill')
    expect(schema?.safeParse({ id: 'translation' }).success).toBe(true)
    expect(schema?.safeParse({ id: 'theme-design' }).success).toBe(false)
    expect(schema?.safeParse({}).success).toBe(false)
  })

  it('has a per-session cap, a status line, and stays out of conversation memory', () => {
    expect(SESSION_TOOL_CALL_CAPS.load_skill).toBe(4)
    expect(describeToolInput('load_skill', { id: 'review' })).not.toBeNull()
    expect(shouldRecordToolInMemory('load_skill')).toBe(false)
  })
})
