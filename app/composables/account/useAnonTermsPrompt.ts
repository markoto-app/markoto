// State of the global accept-terms dialog before an anonymous visitor's
// first document (shared/config/anonGate.ts). `useAnonDocCreate()`
// (useAnonGate.ts) asks; `DocumentAnonGateDialog` answers. Kept apart from
// useAnonGate.ts so CommonAppOverlays can watch the state without loading
// the bot-check solver on every page.

interface TermsPromptState {
  open: boolean
}

let resolveTermsPrompt: ((accepted: boolean) => void) | null = null

/** State of the global accept-terms dialog (one instance, mounted by CommonAppOverlays on first use). */
export function useAnonTermsPrompt() {
  const state = useState<TermsPromptState>('anon-terms-prompt', () => ({ open: false }))

  /** Open the dialog; resolves true once the visitor accepted, false when dismissed. */
  function ask(): Promise<boolean> {
    resolveTermsPrompt?.(false)
    state.value.open = true
    return new Promise<boolean>((resolve) => {
      resolveTermsPrompt = resolve
    })
  }

  function answer(accepted: boolean): void {
    state.value.open = false
    const resolve = resolveTermsPrompt
    resolveTermsPrompt = null
    resolve?.(accepted)
  }

  return { state, ask, answer }
}
