import type { ComputedRef, InjectionKey, WritableComputedRef } from 'vue'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { TabName } from '~/components/editor/tabBarTypes'
import { useProvideSuggestions } from '~/composables/suggestions/useSuggestions'
import { useAiSuggestQuery } from '~/queries/ai'

interface AiSuggestSwitch {
  aiSuggest: WritableComputedRef<boolean>
  forced: ComputedRef<boolean>
}

const AI_SUGGEST_SWITCH: InjectionKey<AiSuggestSwitch> = Symbol('ai-suggest-switch')

/** The prompt bar's "AI suggests" switch state, provided by the editor; null elsewhere. */
export function useAiSuggestSwitch(): AiSuggestSwitch | null {
  return inject(AI_SUGGEST_SWITCH, null)
}

/**
 * Suggestion mode in the editor: one `useSuggestions` instance for the
 * editor marks and the suggestions panel, the Editing / Suggesting choice
 * (fixed on Suggesting when the token says `suggestOnly`), who may accept
 * and reject (people who edit directly), the moves between a suggestion in
 * the text and its card, and the prompt bar's "AI suggests" switch.
 */
export function useEditorSuggestions(opts: {
  ydoc: Y.Doc
  awareness: Awareness
  docId: string
  isReadOnly: Readonly<Ref<boolean>>
  suggestOnly: Readonly<Ref<boolean>>
  rightSidebar: Ref<TabName | null>
  /** Scroll the editor to a range and flash it. */
  flashRange: (from: number, to: number) => void
}) {
  const api = useProvideSuggestions(opts.ydoc, opts.awareness, opts.docId)
  const suggestingChosen = ref(false)
  const suggesting = computed(() => !opts.isReadOnly.value && (opts.suggestOnly.value || suggestingChosen.value))
  const canReview = computed(() => !opts.isReadOnly.value && !opts.suggestOnly.value)
  const count = computed(() => api.suggestions.value.length)

  const panelRef = ref<{ focusSuggestion: (id: string) => void } | null>(null)

  // A suggestion clicked or tapped in the text: open its card (a bottom sheet on a phone).
  function onSuggestionClick(id: string) {
    opts.rightSidebar.value = 'suggestions'
    void nextTick(() => panelRef.value?.focusSuggestion(id))
  }

  // A card clicked: show its place in the text.
  function onSuggestionFocus(id: string) {
    const s = api.suggestions.value.find(x => x.id === id)
    if (s) opts.flashRange(s.from, s.to)
  }

  // "AI suggests instead of editing" for this tab: starts from the user's
  // setting (Settings > AI); the prompt bar's switch overrides it per prompt;
  // the server forces it on where the document requires suggestions.
  const aiSuggestPreference = useAiSuggestQuery()
  const aiSuggestChosen = ref<boolean | null>(null)
  const aiSuggest = computed({
    get: () => aiSuggestChosen.value ?? aiSuggestPreference.data.value?.suggest ?? false,
    set: (v: boolean) => {
      aiSuggestChosen.value = v
    }
  })
  /** What the next prompt asks for; undefined = the user's setting. */
  const aiSuggestRequest = () => aiSuggestChosen.value ?? undefined
  provide(AI_SUGGEST_SWITCH, { aiSuggest, forced: computed(() => opts.suggestOnly.value) })

  return { api, suggestingChosen, suggesting, canReview, count, panelRef, onSuggestionClick, onSuggestionFocus, aiSuggest, aiSuggestRequest }
}
