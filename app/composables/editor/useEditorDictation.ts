import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { EditorView } from '@codemirror/view'

/**
 * Live voice dictation in the editor: a WebSocket relay to Mistral Voxtral
 * Realtime (`useVoiceDictation`). Interim transcripts show as ghost text at
 * the caret (`dictationExtensions.ts`), finalized phrases commit to Y.js
 * there, and the awareness field `dictation` advertises the listening state
 * to collaborators. The ghost stays after the microphone stops (`finishing`)
 * until its text is committed: the composable hands every leftover interim
 * text to `onFinal` before it goes idle. The composable owns the socket; only the editor knows
 * the view, so the ghost text is managed here.
 */
export function useEditorDictation(opts: {
  docId: () => string
  view: () => EditorView | null
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  userId: () => number | null
}) {
  const { t } = useI18n()
  const toast = useToast()

  const dictation = useVoiceDictation({
    docId: computed(opts.docId),
    onPartial: (text) => {
      const view = opts.view()
      if (!view) return
      view.dispatch({ effects: setDictationInterim.of(text) })
    },
    onFinal: (text) => {
      const view = opts.view()
      if (!view) return
      // Clear the ghost first so interim-to-final looks seamless.
      view.dispatch({ effects: setDictationInterim.of('') })
      commitDictationFinal(view, opts.ydoc, opts.ytext, opts.userId(), text)
    },
    onError: (message) => {
      toast.add({
        title: t('ai.dictateErrorTitle'),
        description: message,
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    },
    onBudgetExhausted: () => {
      toast.add({
        title: t('ai.dictateBudgetExhaustedTitle'),
        description: t('ai.dictateBudgetExhaustedDescription'),
        icon: 'i-lucide-battery-low',
        color: 'warning'
      })
    },
    onSessionCap: () => {
      toast.add({
        title: t('ai.dictateSessionCapTitle'),
        description: t('ai.dictateSessionCapDescription'),
        icon: 'i-lucide-clock',
        color: 'info'
      })
    },
    onIdleTimeout: () => {
      toast.add({
        title: t('ai.dictateIdleTitle'),
        description: t('ai.dictateIdleDescription'),
        icon: 'i-lucide-pause',
        color: 'info'
      })
    }
  })

  // Broadcast dictation state via awareness (like `aiStatus`); auto-cleans on disconnect.
  watch(() => dictation.state.value, (s) => {
    const active = s === 'recording' || s === 'connecting' || s === 'requesting-permission'
    opts.awareness.setLocalStateField('dictation', active ? { active: true } : null)
  })

  // Nothing may stay as ghost once the session is over. Leftover interim
  // text was committed through `onFinal` before this state change.
  watch(() => dictation.state.value, (s) => {
    if (s === 'idle' || s === 'error') {
      const view = opts.view()
      if (view) view.dispatch({ effects: setDictationInterim.of('') })
    }
  })

  return dictation
}
