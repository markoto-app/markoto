import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { TabName } from '~/components/editor/tabBarTypes'
import type { CommentRange } from '~/utils/comments/commentDecorations'
import { useProvideComments } from '~/composables/comments/useComments'

/**
 * Comments in the editor: one useComments instance feeds both the sidebar
 * panel (list + composer) and the editor decoration plugin (underlines);
 * two instances would each observe Y.js and briefly disagree.
 * createInjectionState provides and returns the api; CommentsPanel reads the
 * same instance via useCommentsContext. The handlers move between the
 * underline in the editor and the thread in the panel.
 */
export function useEditorComments(opts: {
  ydoc: Y.Doc
  awareness: Awareness
  docId: string
  title: Ref<string>
  isReadOnly: Readonly<Ref<boolean>>
  /** The open right-sidebar panel: a comment action opens the comments panel. */
  rightSidebar: Ref<TabName | null>
  /** Scroll the editor to a range and flash it. */
  flashRange: (from: number, to: number) => void
}) {
  const commentsApi = useProvideComments(opts.ydoc, opts.awareness, opts.docId)
  const commentRanges = computed<CommentRange[]>(() =>
    commentsApi.comments.value
      .flatMap(c => c.anchor && !c.resolved ? [{ id: c.id, from: c.anchor.from, to: c.anchor.to }] : [])
  )

  // OS notification on replies to a thread I authored, only while the tab is
  // hidden and permission is granted. Permission is asked lazily at the first
  // such reply, not on page open.
  useCommentNotifications({
    comments: commentsApi.comments,
    awareness: opts.awareness,
    docTitle: opts.title,
    docId: opts.docId
  })

  // The layout calls `startDraft()` on `create-comment` (toolbar / menu) and
  // `focusComment(id)` when the editor emits a click on a comment underline.
  const commentsPanelRef = ref<{
    startDraft: () => boolean
    focusComment: (id: string) => void
  } | null>(null)

  function flashEditorComment(id: string) {
    const c = commentsApi.comments.value.find(x => x.id === id)
    if (!c?.anchor) return
    opts.flashRange(c.anchor.from, c.anchor.to)
  }

  // Comment underline click: open the panel, scroll the thread into view, flash the editor range.
  function onCommentClickInEditor(id: string) {
    opts.rightSidebar.value = 'comments'
    // Wait a tick so the panel mounts before it is asked to scroll.
    void nextTick(() => {
      commentsPanelRef.value?.focusComment(id)
      flashEditorComment(id)
    })
  }

  // Toolbar / menu "Comment" starts a draft; the panel handles the "no selection" hint.
  function triggerCreateComment() {
    if (opts.isReadOnly.value) return
    opts.rightSidebar.value = 'comments'
    void nextTick(() => {
      commentsPanelRef.value?.startDraft()
    })
  }

  // The user clicked a thread (or its "Show in document"): scroll the editor to it and flash the anchor.
  function onCommentPanelFocus(id: string) {
    flashEditorComment(id)
  }

  return { commentRanges, commentsPanelRef, onCommentClickInEditor, triggerCreateComment, onCommentPanelFocus }
}
