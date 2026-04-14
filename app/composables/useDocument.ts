import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

/**
 * Thin orchestrator that wires together the three sub-composables a document
 * needs:
 *   - `useDocToken`       — /token fetch, access-mode, password-unlock flow
 *   - `useHocuspocusSync` — provider lifecycle, status/synced/userCount
 *   - (owned here)        — Y.Doc itself, title bridge, deletion observer,
 *                           awareness bootstrap, welcome-doc seeding
 *
 * External API must stay bit-for-bit stable — `EditorLayout.vue` destructures
 * 17 fields from this return.
 */
export function useDocument(docId: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap('meta')

  // Single stable Awareness instance — passed to HocuspocusProvider so both
  // local and remote clients share the same object. Components (PresenceBar,
  // yCollab) bind to this once at mount and never need to re-subscribe.
  const awareness = new Awareness(ydoc)

  const undoManager = new Y.UndoManager(ytext)

  const { loggedIn, user: sessionUser } = useUserSession()

  // Access-mode / password / ownership state.
  const tokenState = useDocToken(docId)

  // Provider lifecycle. Reads the token lazily via `getToken` so the
  // post-password-verify reconnect picks up the fresh JWT automatically.
  const sync = useHocuspocusSync({
    docId,
    ydoc,
    awareness,
    syncUrl: useRuntimeConfig().public.syncUrl,
    getToken: () => tokenState.tokenData.value?.token || '',
    onSynced: () => {
      insertWelcomeIfEmpty()
      // If this sync came after password verification, now it's safe to show
      // the editor content — flipping `requiresPassword` false causes the
      // template's `v-if` gate to mount the editor.
      tokenState.clearPendingUnlock()
    },
    onDisconnect: (everSynced) => {
      // Server unreachable from the first try? Seed welcome so the user isn't
      // staring at an empty editor. If we'd already synced once, the doc has
      // real content (possibly) and the welcome seed would be wrong.
      if (!everSynced) insertWelcomeIfEmpty()
    },
    onAuthFailed: () => {
      tokenState.markReadOnly()
    }
  })

  function insertWelcomeIfEmpty() {
    if (ytext.length === 0 && !tokenState.isReadOnly.value) {
      ytext.insert(0, welcomeMarkdown)
    }
  }

  // Awareness bootstrap. A placeholder name/color is set eagerly so yCollab
  // (which may attach before `connect()` runs) has something to show. The
  // real session-aware values are re-applied inside `connect()`.
  awareness.setLocalStateField('user', {
    name: generateRandomName(),
    color: pickColor()
  })

  function applySessionAwareness() {
    awareness.setLocalStateField('user', {
      name: loggedIn.value ? sessionUser.value?.name : generateRandomName(),
      color: pickColor(),
      avatar: sessionUser.value?.avatar
    })
  }

  // Bridge Y.js Map reactivity to Vue: `ymeta.get()` isn't tracked by Vue,
  // so we observe the Map and update a reactive ref on every change.
  const _titleRef = ref((ymeta.get('title') as string) || 'Untitled')
  // `_deleted` flag is set by the sync-server when the owner deletes the doc —
  // all connected clients see this via Y.js broadcast and redirect away.
  const isDeleted = ref(!!ymeta.get('_deleted'))
  ymeta.observe(() => {
    _titleRef.value = (ymeta.get('title') as string) || 'Untitled'
    if (ymeta.get('_deleted')) isDeleted.value = true
  })

  const title = computed({
    get: () => _titleRef.value,
    set: (v: string) => {
      if (!tokenState.isReadOnly.value) ymeta.set('title', v)
    }
  })

  const docSizeWarning = computed(() => {
    const mb = sync.docSizeBytes.value / (1024 * 1024)
    if (mb > 8) return 'critical'
    if (mb > 5) return 'warning'
    return null
  })

  // Initial connect. Password-protected / private docs must NOT connect until
  // the user unlocks them, otherwise content syncs before the gate appears.
  tokenState.fetchToken().then(() => {
    applySessionAwareness()
    if (!tokenState.requiresPassword.value && !tokenState.forbidden.value) {
      sync.connect()
    }
  })

  /**
   * Called by PasswordModal. Updates the token in place, then reconnects the
   * provider with the new JWT. `requiresPassword` stays true until the first
   * sync completes — see `onSynced` above.
   */
  function onPasswordVerified(newToken: string) {
    tokenState.onPasswordVerified(newToken)
    sync.reconnect()
  }

  function destroy() {
    sync.destroy()
    awareness.destroy()
    ydoc.destroy()
  }

  onUnmounted(() => {
    destroy()
  })

  return {
    ydoc,
    ytext,
    awareness,
    provider: readonly(sync.provider),
    status: readonly(sync.status),
    synced: readonly(sync.synced),
    userCount: readonly(sync.userCount),
    isReadOnly: readonly(tokenState.isReadOnly),
    isOwner: readonly(tokenState.isOwner),
    isDeleted: readonly(isDeleted),
    requiresPassword: readonly(tokenState.requiresPassword),
    forbidden: readonly(tokenState.forbidden),
    accessMode: readonly(tokenState.accessMode),
    docSizeBytes: readonly(sync.docSizeBytes),
    docSizeWarning,
    undoManager,
    title,
    onPasswordVerified,
    setAccessMode: tokenState.setAccessMode,
    destroy
  }
}
