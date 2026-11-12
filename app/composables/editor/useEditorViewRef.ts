import type { EditorView } from '@codemirror/view'

/**
 * The CodeMirror view of the editor pane (bound with `ref="editorPaneRef"`)
 * and whether it was ever focused this session. CM6's selection sits at 0 by
 * default, so without the focus flag every fresh doc would report "cursor on
 * line 1" to the AI prompt path.
 */
export function useEditorViewRef() {
  const editorEverFocused = ref(false)
  // Vue's `ref<{ view: EditorView | null }>` applies `UnwrapRef` recursively,
  // turning `EditorView` into `Readonly<EditorView>`, which TS rejects (classes
  // with private fields are nominal). The cast in the computed re-asserts the
  // real type; the child's shallowRef keeps the instance unproxied, so it is safe.
  const editorPaneRef = ref<{
    view: EditorView | null
    flashCommentRange?: (from: number, to: number) => void
  } | null>(null)
  const editorView = computed<EditorView | null>(
    () => (editorPaneRef.value?.view ?? null) as EditorView | null
  )

  // First-focus tracker: attaches a one-shot focus listener to CM6's contentDOM
  // (where keyboard focus lands), not the outer `.cm-editor`.
  watch(editorView, (view, prev) => {
    if (prev && !view) editorEverFocused.value = false // editor remounted — reset
    if (!view) return
    if (view.hasFocus) {
      // Rare: the editor auto-focused before this watcher ran (e.g. parent
      // restored focus after a password-gate dismiss).
      editorEverFocused.value = true
      return
    }
    const handler = () => {
      editorEverFocused.value = true
      view.contentDOM.removeEventListener('focus', handler)
    }
    view.contentDOM.addEventListener('focus', handler)
  }, { immediate: true })

  return { editorPaneRef, editorView, editorEverFocused }
}
