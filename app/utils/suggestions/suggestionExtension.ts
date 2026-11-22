import { EditorSelection, EditorState, Facet, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { ySyncAnnotation } from 'y-codemirror.next'
import { planSuggestion, type SuggestChange, type SuggestPlan } from '~~/shared/utils/suggestions/plan'

// CodeMirror side of suggestion mode.
//
//   - Shows every open suggestion: struck text as a mark, inserted text as
//     an inline widget at the end of the range, both in the author's
//     colour. The host (EditorPane) sends the resolved list with
//     `setSuggestionMarks` whenever the Y.js map or the text changes.
//   - While suggesting, a transaction filter keeps local edits out of the
//     text: each change is planned into suggestion writes (shared/utils/
//     suggestions/plan.ts), the transaction keeps only the caret move, and
//     the writes are handed to the host after the update (it owns the
//     Y.js map). Remote changes (yCollab) and undo / redo, which arrive as
//     Y.js updates, pass untouched.

export interface SuggestionMark {
  id: string
  from: number
  to: number
  text: string
  color: string
  /** Written by the local author: typing continues it. */
  mine: boolean
  /** Nothing left to change (struck text gone, no text): drawn faintly. */
  obsolete: boolean
  authorName: string
  /** Written by the AI: drawn with a bar on its leading edge. */
  ai?: boolean
}

export const setSuggestionMarks = StateEffect.define<SuggestionMark[]>()

/** The plan of one local edit made while suggesting, for the host to write. */
const suggestionPlanned = StateEffect.define<SuggestPlan>()

/** Whether local edits become suggestions. Reconfigured through a compartment by the host. */
export const suggestingFacet = Facet.define<boolean, boolean>({
  combine: values => values.some(Boolean)
})

export function isSuggesting(state: EditorState): boolean {
  return state.facet(suggestingFacet)
}

const marksField = StateField.define<SuggestionMark[]>({
  create: () => [],
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setSuggestionMarks)) return e.value
    if (!tr.docChanged) return marks
    // Follow remote edits until the host re-resolves the anchors.
    return marks.map((m) => {
      const from = tr.changes.mapPos(m.from, 1)
      const to = Math.max(from, tr.changes.mapPos(m.to, -1))
      return { ...m, from, to }
    })
  }
})

class InsertionWidget extends WidgetType {
  constructor(readonly mark: SuggestionMark) {
    super()
  }

  override eq(other: InsertionWidget): boolean {
    return other.mark.id === this.mark.id && other.mark.text === this.mark.text && other.mark.color === this.mark.color && other.mark.obsolete === this.mark.obsolete && other.mark.ai === this.mark.ai
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.mark.ai ? 'cm-suggest-ins cm-suggest-ai' : 'cm-suggest-ins'
    el.textContent = this.mark.text
    el.dataset.suggestionId = this.mark.id
    el.style.setProperty('--suggest-color', this.mark.color)
    el.title = this.mark.authorName
    return el
  }

  override ignoreEvent(): boolean {
    // Let clicks reach the editor's handler (opens the card).
    return false
  }
}

function decorationsOf(marks: readonly SuggestionMark[], docLength: number): DecorationSet {
  const ranges = []
  for (const m of marks) {
    const from = Math.max(0, Math.min(m.from, docLength))
    const to = Math.max(from, Math.min(m.to, docLength))
    const style = `--suggest-color: ${m.color}`
    if (to > from) {
      ranges.push(Decoration.mark({
        class: `cm-suggest-del${m.ai ? ' cm-suggest-ai' : ''}${m.obsolete ? ' cm-suggest-obsolete' : ''}`,
        attributes: { 'data-suggestion-id': m.id, 'style': style, 'title': m.authorName }
      }).range(from, to))
    }
    if (m.text.length > 0) {
      // side -1: drawn before a caret at `to`, so typing continues after it.
      ranges.push(Decoration.widget({ widget: new InsertionWidget(m), side: -1 }).range(to))
    }
  }
  return Decoration.set(ranges, true)
}

const decorations = EditorView.decorations.compute([marksField], state => decorationsOf(state.field(marksField), state.doc.length))

/** A local change made while suggesting: everything but yCollab's own replay of Y.js updates (remote edits, undo). */
function isLocalEdit(tr: Transaction): boolean {
  return tr.docChanged && tr.annotation(ySyncAnnotation) === undefined
}

const planFilter = EditorState.transactionFilter.of((tr) => {
  if (!isLocalEdit(tr) || !isSuggesting(tr.startState)) return tr
  const changes: SuggestChange[] = []
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString() })
  })
  const own = tr.startState.field(marksField)
    .filter(m => m.mine && !m.obsolete)
    .map(m => ({ id: m.id, from: m.from, to: m.to, text: m.text }))
  const backward = tr.isUserEvent('delete.backward')
  const plan = planSuggestion(changes, own, backward)
  const cursor = Math.min(plan.cursor, tr.startState.doc.length)
  return {
    selection: EditorSelection.cursor(cursor),
    effects: suggestionPlanned.of(plan),
    scrollIntoView: true,
    annotations: Transaction.userEvent.of('select')
  }
})

export interface SuggestionExtensionOptions {
  /** Called after the update with the writes of a local edit made while suggesting. */
  onPlan: (plan: SuggestPlan, view: EditorView) => void
  /** A suggestion's mark or inserted text was clicked or tapped. */
  onSuggestionClick?: (id: string) => void
}

export function suggestionExtension(opts: SuggestionExtensionOptions): Extension {
  return [
    marksField,
    decorations,
    planFilter,
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        for (const e of tr.effects) if (e.is(suggestionPlanned)) opts.onPlan(e.value, update.view)
      }
    }),
    EditorView.domEventHandlers({
      click(e: MouseEvent) {
        const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-suggestion-id]')
        const id = el?.dataset.suggestionId
        if (id && opts.onSuggestionClick) opts.onSuggestionClick(id)
      }
    })
  ]
}
