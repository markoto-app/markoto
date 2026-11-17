import { describe, expect, it } from 'vitest'
import { buildWorkerPrompt, JOB_UNIT_SEPARATOR, WORKER_SYSTEM_PROMPT, type WorkerJobSpec } from '../../../../server/utils/ai/jobs/workerPrompt'

const translate: WorkerJobSpec = {
  mode: 'translate',
  instruction: 'Translate into English.',
  targetLanguage: 'English',
  audience: 'technical',
  style: 'British spelling.',
  glossary: [{ source: 'Netzleitstelle', target: 'network control centre' }],
  styleAnchors: ['An approved sample.'],
  headingMap: [{ from: 'Methoden', to: 'Methods' }]
}
const rewrite: WorkerJobSpec = { mode: 'rewrite', instruction: 'Formal register.' }

const unitA = { headingPath: '1 A', before: 'prev', after: 'next', unit: 'Text A ⟦P1⟧' }
const unitB = { headingPath: '2 B > 2.1 C', before: '', after: '', unit: 'Text B' }

describe('worker prompt layout', () => {
  it('the system part is byte-identical across jobs and units', () => {
    const prompts = [buildWorkerPrompt(translate, unitA), buildWorkerPrompt(translate, unitB), buildWorkerPrompt(rewrite, unitA)]
    for (const p of prompts) {
      expect(p.messages[0]).toEqual({ role: 'system', content: WORKER_SYSTEM_PROMPT })
      expect(p.parts.system).toBe(WORKER_SYSTEM_PROMPT)
    }
    expect(WORKER_SYSTEM_PROMPT).not.toMatch(/translate into|Formal register|Netzleitstelle/i)
  })

  it('the job part is identical for every unit of a job and opens the user message', () => {
    const a = buildWorkerPrompt(translate, unitA)
    const b = buildWorkerPrompt(translate, { ...unitB, retryProblems: ['Placeholder ⟦P1⟧ is missing.'] })
    expect(a.parts.job).toBe(b.parts.job)
    const prefix = `${a.parts.job}${JOB_UNIT_SEPARATOR}`
    expect(a.messages[1]!.content.startsWith(prefix)).toBe(true)
    expect(b.messages[1]!.content.startsWith(prefix)).toBe(true)
    expect(a.parts.job).not.toBe(buildWorkerPrompt(rewrite, unitA).parts.job)
  })

  it('carries the job settings and the unit with its read-only context', () => {
    const p = buildWorkerPrompt(translate, unitA)
    for (const s of ['Target language: English', 'British spelling.', 'Netzleitstelle => network control centre', 'Methoden => Methods', 'An approved sample.', 'engineering audience']) {
      expect(p.parts.job).toContain(s)
    }
    expect(p.parts.unit).toBe('Heading path: 1 A\n<before>\nprev\n</before>\n<after>\nnext\n</after>\n<unit>\nText A ⟦P1⟧\n</unit>')
    expect(buildWorkerPrompt(rewrite, unitB).parts.unit).not.toContain('<before>')
  })

  it('appends retry feedback after the unit', () => {
    const p = buildWorkerPrompt(rewrite, { ...unitA, retryProblems: ['Placeholder ⟦P1⟧ is missing.'] })
    expect(p.parts.unit.endsWith('- Placeholder ⟦P1⟧ is missing.\nAnswer again and fix these problems.')).toBe(true)
  })
})
