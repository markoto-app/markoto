import { describe, it, expect, vi, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ySyncAnnotation } from 'y-codemirror.next'
import { isSuggesting, setSuggestionMarks, suggestingFacet, suggestionExtension, type SuggestionMark } from '../../app/utils/suggestions/suggestionExtension'
import type { SuggestPlan } from '../../shared/utils/suggestions/plan'

// The editor side of suggestion mode: while suggesting, local edits never
// reach the text; they are planned into suggestion writes. Remote edits
// (yCollab replays) pass, and the marks render as strike / insert widgets.

const remoteConfig = Object.create(null) as never
const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function mount(doc: string, suggesting: boolean, extra: { onPlan?: (p: SuggestPlan) => void, onClick?: (id: string) => void } = {}) {
  const onPlan = vi.fn((p: SuggestPlan) => extra.onPlan?.(p))
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [suggestingFacet.of(suggesting), suggestionExtension({ onPlan: p => onPlan(p), onSuggestionClick: extra.onClick })]
    })
  })
  views.push(view)
  return { view, onPlan }
}

const mark = (over: Partial<SuggestionMark> = {}): SuggestionMark => ({
  id: 's1', from: 4, to: 9, text: 'slow', color: '#C8442C', mine: true, obsolete: false, authorName: 'Bea', ...over
})

describe('suggestionExtension', () => {
  it('reports the facet', () => {
    expect(isSuggesting(mount('x', true).view.state)).toBe(true)
    expect(isSuggesting(mount('x', false).view.state)).toBe(false)
  })

  it('keeps a local edit out of the text and hands its plan to the host', () => {
    const { view, onPlan } = mount('The quick fox', true)
    view.dispatch({ changes: { from: 4, to: 9, insert: 'slow' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toBe('The quick fox')
    expect(onPlan).toHaveBeenCalledTimes(1)
    const plan = onPlan.mock.calls[0]![0]
    expect(plan.writes).toEqual([{ kind: 'create', from: 4, to: 9, text: 'slow' }])
    expect(view.state.selection.main.head).toBe(plan.cursor)
  })

  it('plans a deletion as a suggestion and continues an own insertion on the next keystroke', () => {
    const { view, onPlan } = mount('Hi there', true)
    view.dispatch({ changes: { from: 0, to: 0, insert: 'A' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toBe('Hi there')
    view.dispatch({ effects: setSuggestionMarks.of([mark({ id: 'own', from: 0, to: 0, text: 'A' })]) })
    view.dispatch({ changes: { from: 0, to: 0, insert: 'B' }, userEvent: 'input.type' })
    const second = onPlan.mock.calls[1]![0]
    expect(second.writes[0]).toMatchObject({ kind: 'update', id: 'own', text: 'AB' })
  })

  it('does not continue suggestions of someone else or obsolete ones', () => {
    const { view, onPlan } = mount('Hi there', true)
    view.dispatch({ effects: setSuggestionMarks.of([mark({ id: 'theirs', from: 0, to: 0, text: 'A', mine: false }), mark({ id: 'dead', from: 0, to: 0, text: 'A', obsolete: true })]) })
    view.dispatch({ changes: { from: 0, to: 0, insert: 'B' }, userEvent: 'input.type' })
    expect(onPlan.mock.calls[0]![0].writes[0]).toMatchObject({ kind: 'create', text: 'B' })
  })

  it('treats delete.backward as a backward delete', () => {
    const { view, onPlan } = mount('Hello', true)
    view.dispatch({ changes: { from: 4, to: 5 }, userEvent: 'delete.backward' })
    expect(view.state.doc.toString()).toBe('Hello')
    expect(onPlan.mock.calls[0]![0].writes[0]).toMatchObject({ kind: 'create', from: 4, to: 5, text: '' })
  })

  it('lets edits through when not suggesting', () => {
    const { view, onPlan } = mount('abc', false)
    view.dispatch({ changes: { from: 3, insert: 'd' } })
    expect(view.state.doc.toString()).toBe('abcd')
    expect(onPlan).not.toHaveBeenCalled()
  })

  it('lets remote edits (y-sync annotated) through while suggesting', () => {
    const { view, onPlan } = mount('abc', true)
    view.dispatch({ changes: { from: 3, insert: 'd' }, annotations: ySyncAnnotation.of(remoteConfig) })
    expect(view.state.doc.toString()).toBe('abcd')
    expect(onPlan).not.toHaveBeenCalled()
  })

  it('renders struck text and inserted text with the author colour', () => {
    const { view } = mount('The quick fox', false)
    view.dispatch({ effects: setSuggestionMarks.of([mark(), mark({ id: 's2', from: 10, to: 13, text: '', obsolete: true })]) })
    const del = view.dom.querySelectorAll<HTMLElement>('.cm-suggest-del')
    expect(del).toHaveLength(2)
    expect(del[0]!.textContent).toBe('quick')
    expect(del[0]!.getAttribute('style')).toContain('--suggest-color: #C8442C')
    expect(del[1]!.className).toContain('cm-suggest-obsolete')
    const ins = view.dom.querySelectorAll<HTMLElement>('.cm-suggest-ins')
    expect(ins).toHaveLength(1)
    expect(ins[0]!.textContent).toBe('slow')
    expect(ins[0]!.dataset.suggestionId).toBe('s1')
    expect(ins[0]!.title).toBe('Bea')
  })

  it('clamps marks that point past the document end', () => {
    const { view } = mount('abc', false)
    view.dispatch({ effects: setSuggestionMarks.of([mark({ from: 1, to: 50, text: '' })]) })
    expect(view.dom.querySelector('.cm-suggest-del')!.textContent).toBe('bc')
  })

  it('moves marks along with remote edits until the host re-resolves them', () => {
    const { view } = mount('The quick fox', false)
    view.dispatch({ effects: setSuggestionMarks.of([mark({ text: '' })]) })
    view.dispatch({ changes: { from: 0, insert: 'Well, ' }, annotations: ySyncAnnotation.of(remoteConfig) })
    expect(view.dom.querySelector('.cm-suggest-del')!.textContent).toBe('quick')
  })

  it('opens the card when a mark or inserted text is clicked', () => {
    const onClick = vi.fn()
    const { view } = mount('The quick fox', false, { onClick })
    view.dispatch({ effects: setSuggestionMarks.of([mark()]) })
    view.dom.querySelector<HTMLElement>('.cm-suggest-del')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    view.dom.querySelector<HTMLElement>('.cm-suggest-ins')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    view.contentDOM.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(onClick).toHaveBeenCalledWith('s1')
  })

  it('widget equality follows id, text, colour and obsolescence', () => {
    const { view } = mount('The quick fox', false)
    view.dispatch({ effects: setSuggestionMarks.of([mark()]) })
    const first = view.dom.querySelector('.cm-suggest-ins')
    view.dispatch({ effects: setSuggestionMarks.of([mark()]) })
    expect(view.dom.querySelector('.cm-suggest-ins')).toBe(first)
    view.dispatch({ effects: setSuggestionMarks.of([mark({ text: 'slower' })]) })
    expect(view.dom.querySelector('.cm-suggest-ins')!.textContent).toBe('slower')
  })
})
