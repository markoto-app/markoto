// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CompletionContext } from '@codemirror/autocomplete'
import type { Tooltip } from '@codemirror/view'

import { citationAssist, type CitationAssistSource } from '../../../app/utils/editor/citationAssist'
import type { CslItem } from '../../../shared/utils/citations/cslItem'
// The completion and hover sources are internal; capture them as the extension hands them to CodeMirror.
const captured = vi.hoisted(() => ({ complete: null as null | ((c: unknown) => unknown), hover: null as null | ((v: unknown, p: number) => unknown) }))
vi.mock('@codemirror/autocomplete', async (orig) => {
  const actual = await orig<typeof import('@codemirror/autocomplete')>()
  return { ...actual, autocompletion: (cfg: { override: Array<(c: unknown) => unknown> }) => {
    captured.complete = cfg.override[0]!
    return []
  } }
})
vi.mock('@codemirror/view', async (orig) => {
  const actual = await orig<typeof import('@codemirror/view')>()
  return { ...actual, hoverTooltip: (fn: (v: unknown, p: number) => unknown) => {
    captured.hover = fn
    return []
  } }
})

const smith = { id: 'smith2020', type: 'article-journal', title: 'A Study of Things', author: [{ family: 'Smith', given: 'John' }], issued: { 'date-parts': [[2020]] } } as unknown as CslItem

const src: CitationAssistSource = {
  items: () => [smith],
  style: () => 'apa' as never,
  locale: () => 'en',
  labelWord: kind => ({ fig: 'Figure', tbl: 'Table', eq: 'Equation', sec: 'Section' })[kind],
  unknownText: key => `Unknown: ${key}`
}

citationAssist(src)

async function complete(doc: string, explicit = false) {
  const state = EditorState.create({ doc })
  return captured.complete!(new CompletionContext(state, doc.length, explicit)) as { from: number, options: Array<{ label: string, detail?: string }> } | null
}

function hover(doc: string, pos: number): { tip: Tooltip | null, text: string | null } {
  const view = new EditorView({ state: EditorState.create({ doc }) })
  const tip = captured.hover!(view, pos) as Tooltip | null
  const text = tip ? (tip.create(view).dom.textContent) : null
  view.destroy()
  return { tip, text }
}

describe('citation completion', () => {
  it('offers bibliography keys and defined labels after [@', async () => {
    const r = await complete('See {#fig:map} and [@sm')
    expect(r).not.toBeNull()
    expect(r!.from).toBe('See {#fig:map} and [@'.length)
    const labels = r!.options.map(o => o.label)
    expect(labels).toContain('smith2020')
    expect(labels).toContain('fig:map')
    expect(r!.options.find(o => o.label === 'fig:map')!.detail).toBe('Figure')
    expect(r!.options.find(o => o.label === 'smith2020')!.detail).toContain('Smith')
  })

  it('offers keys in the suppress-author form [-@', async () => {
    const r = await complete('As shown [-@sm')
    expect(r).not.toBeNull()
    expect(r!.from).toBe('As shown [-@'.length)
    expect(r!.options.map(o => o.label)).toContain('smith2020')
  })

  it('does not trigger on an @ inside a word (e-mail address)', async () => {
    expect(await complete('mail me at joe@exa')).toBeNull()
  })

  it('offers on a lone @ after a space or bracket, not after other text', async () => {
    expect(await complete('see @')).not.toBeNull()
    expect(await complete('[@')).not.toBeNull()
    expect(await complete('x@')).toBeNull()
  })

  it('returns nothing without an @ word before the cursor', async () => {
    expect(await complete('plain text')).toBeNull()
  })

  it('offers nothing when there are no keys and no labels', async () => {
    const saved = src.items
    src.items = () => []
    try {
      expect(await complete('[@s')).toBeNull()
    } finally {
      src.items = saved
    }
  })
})

describe('citation hover', () => {
  it('shows the formatted entry for a known key', () => {
    const { tip, text } = hover('As in [@smith2020] we', 8)
    expect(tip!.above).toBe(true)
    expect(tip!.pos).toBe(7)
    expect(text).toContain('Smith')
    expect(text).toContain('2020')
  })

  it('says a bracketed unknown key is unknown', () => {
    expect(hover('As in [@ghost] we', 9).text).toBe('Unknown: ghost')
  })

  it('shows nothing for a bare @word that is no key (a mention)', () => {
    expect(hover('Thanks @ghost for it', 9).tip).toBeNull()
  })

  it('shows nothing when no @ is near the position', () => {
    expect(hover('no citation here', 4).tip).toBeNull()
    expect(hover('mail joe@smith2020 x', 12).tip).toBeNull()
  })

  it('describes a defined label and flags an undefined one', () => {
    expect(hover('{#fig:map} see @fig:map', 20).text).toBe('Figure: fig:map')
    expect(hover('see @tbl:nope', 8).text).toBe('Unknown: tbl:nope')
  })
})
