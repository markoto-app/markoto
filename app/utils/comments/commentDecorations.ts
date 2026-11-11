import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

// CM6 extension that marks every active comment anchor. The host
// (EditorPane) dispatches `setCommentRanges` when the comment list
// changes. The mark carries the comment id as a data attribute, so one
// `domEventHandlers.click` routes clicks to the thread.

export interface CommentRange {
  id: string
  from: number
  to: number
}

export const setCommentRanges = StateEffect.define<CommentRange[]>()

/** Briefly highlight a range with `.cm-comment-flash` (sidebar thread click). `null` clears it. */
export const setFlashRange = StateEffect.define<{ from: number, to: number } | null>()

const commentMark = (id: string) => Decoration.mark({
  class: 'cm-comment-anchor',
  attributes: { 'data-comment-id': id }
})

const flashMark = Decoration.mark({ class: 'cm-comment-flash' })

const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // Map across edits so the underline follows the text until the next
    // setCommentRanges dispatch re-resolves the Y.js anchors.
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setCommentRanges)) {
        const ranges = e.value
          .filter(r => r.from >= 0 && r.from < r.to)
          .sort((a, b) => a.from - b.from || a.to - b.to)
          .map(r => commentMark(r.id).range(r.from, r.to))
        deco = Decoration.set(ranges, true)
      }
    }
    return deco
  },
  provide: (f: StateField<DecorationSet>) => EditorView.decorations.from(f)
})

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setFlashRange)) {
        if (e.value === null) {
          deco = Decoration.none
        } else if (e.value.from < e.value.to) {
          deco = Decoration.set([flashMark.range(e.value.from, e.value.to)])
        }
      }
    }
    return deco
  },
  provide: (f: StateField<DecorationSet>) => EditorView.decorations.from(f)
})

export interface CommentDecorationsOptions {
  onCommentClick?: (id: string) => void
}

export function commentDecorationsExtension(opts: CommentDecorationsOptions = {}): Extension {
  const clickHandler = EditorView.domEventHandlers({
    click(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      const el = target.closest('[data-comment-id]') as HTMLElement | null
      if (!el) return
      const id = el.dataset.commentId
      if (id && opts.onCommentClick) {
        opts.onCommentClick(id)
      }
    }
  })
  return [commentField, flashField, clickHandler]
}
