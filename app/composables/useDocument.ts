import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { isValidTheme } from '~~/shared/utils/themeValidation'
import {
  readThemeFromYmeta,
  canEditTheme as computeCanEditTheme,
  docSizeWarning as computeDocSizeWarning
} from '~~/shared/utils/documentHelpers'

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
      // Template body wins when present (server pre-rendered with the
      // doc's title/description, locale-matched on doc.language). The
      // `blank` template renders to null and we fall through to the
      // generic welcome doc — same behaviour as docs created before
      // templates shipped, so legacy + blank-template docs stay
      // consistent.
      const seed = tokenState.initialBody.value ?? welcomeMarkdown
      ytext.insert(0, seed)
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
      // Seed `id` from the session so remote clients can match this awareness
      // state to a workspace-member row (role tooltips, "is this person live"
      // lookup in PresenceBar). Unauthenticated visitors stay id-less and
      // appear as "Anonymous editor" downstream.
      id: loggedIn.value ? sessionUser.value?.id : undefined,
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
  // Theme: lives on ymeta.theme as a plain JSON object so changes broadcast
  // to all collaborators in the same way the title does. Falls back to the
  // hardcoded `defaultTheme` until either (a) the /token round-trip seeds
  // the DB-stored theme, or (b) sync delivers what's currently on the doc.
  const _themeRef = ref<DocTheme>(defaultTheme)
  // Document context — same dual-source pattern as theme. Initial values
  // come from /token; ymeta mirrors take over once sync is live so changes
  // broadcast to every collaborator.
  const _descriptionRef = ref<string>((ymeta.get('description') as string) ?? '')
  const _audienceRef = ref<string>((ymeta.get('audience') as string) ?? 'casual')
  const _languageRef = ref<string>((ymeta.get('language') as string) ?? 'en')
  ymeta.observe(() => {
    _titleRef.value = (ymeta.get('title') as string) || 'Untitled'
    if (ymeta.get('_deleted')) isDeleted.value = true
    _themeRef.value = readThemeFromYmeta(ymeta)
    const d = ymeta.get('description')
    if (typeof d === 'string') _descriptionRef.value = d
    const a = ymeta.get('audience')
    if (typeof a === 'string') _audienceRef.value = a
    const l = ymeta.get('language')
    if (typeof l === 'string') _languageRef.value = l
  })

  const title = computed({
    get: () => _titleRef.value,
    set: (v: string) => {
      if (!tokenState.isReadOnly.value) ymeta.set('title', v)
    }
  })

  /**
   * Theme write access mirrors content write access:
   *   - read-only? no.
   *   - has an owner and you're not them? no.
   *   - no owner (anonymous-created doc)? yes — same liberal default
   *     as the doc itself, since open-edit means "anyone can change
   *     anything".
   * The DB-write path uses PUT /meta which checks ownership server-side
   * for owned docs; for ownerless docs the meta endpoint would 403 today.
   * That's covered below — we skip the persist call when there's no
   * owner and let Y.js sync be the source of truth.
   */
  const canEditTheme = computed(() => computeCanEditTheme({
    isReadOnly: tokenState.isReadOnly.value,
    isOwner: tokenState.isOwner.value,
    hasOwner: tokenState.hasOwner.value
  }))

  /**
   * Pushes into ymeta (broadcasts live to all clients) and, for owned
   * docs, persists to the DB row via PUT /meta (debounced) so a fresh
   * visitor on a brand-new socket sees the right theme during the
   * window before y-postgresql replays the Y.js update history.
   *
   * For ownerless docs the DB row stays NULL — Y.js is the only source
   * of truth and the next visitor seeds from sync, not the DB. (The
   * `/meta` endpoint requires ownership and would 403 us anyway.)
   *
   * The DB write is best-effort — Y.js stays the live source of truth,
   * the DB is just the seed for new sessions.
   */
  const persistTheme = useDebounceFn((next: DocTheme) => {
    $fetch(`/api/docs/${docId}/meta`, {
      method: 'PUT',
      body: { theme: next }
    }).catch(() => {})
  }, 800)

  // Same pattern as `persistTheme`: ymeta is the live source, the DB
  // row is a seed for new sessions. Owner-only writes — non-owners on
  // open-edit docs CAN touch ymeta (and broadcast to collaborators)
  // but the /meta endpoint is owner-gated, so the DB persist is a
  // no-op for them. Y.js sync becomes the only persistence surface in
  // that case (same trade-off as theme on ownerless docs).
  const persistDocContext = useDebounceFn((next: { description?: string, audience?: string, language?: string }) => {
    $fetch(`/api/docs/${docId}/meta`, {
      method: 'PUT',
      body: next
    }).catch(() => {})
  }, 800)

  function setTheme(next: DocTheme) {
    if (!canEditTheme.value) return
    if (!isValidTheme(next)) return
    ymeta.set('theme', next) // observer above updates _themeRef
    if (tokenState.isOwner.value) persistTheme(next)
  }

  // Reset to defaults — clears the ymeta entry and (for owned docs) asks
  // the server to null the DB column. After this, `readTheme()` falls
  // back to `defaultTheme` for everyone.
  function resetTheme() {
    if (!canEditTheme.value) return
    ymeta.delete('theme')
    _themeRef.value = defaultTheme
    if (tokenState.isOwner.value) {
      $fetch(`/api/docs/${docId}/meta`, {
        method: 'PUT',
        body: { theme: null }
      }).catch(() => {})
    }
  }

  const theme = readonly(_themeRef)

  /**
   * Document context setters — same write semantics as theme. Owner +
   * editors can change them; viewers cannot. Y.js broadcasts the
   * change live; the owner-side debounced persist seeds the DB row.
   */
  const description = computed({
    get: () => _descriptionRef.value,
    set: (v: string) => {
      if (tokenState.isReadOnly.value) return
      ymeta.set('description', v)
      if (tokenState.isOwner.value) persistDocContext({ description: v })
    }
  })
  const audience = computed({
    get: () => _audienceRef.value,
    set: (v: string) => {
      if (tokenState.isReadOnly.value) return
      ymeta.set('audience', v)
      if (tokenState.isOwner.value) persistDocContext({ audience: v })
    }
  })
  const language = computed({
    get: () => _languageRef.value,
    set: (v: string) => {
      if (tokenState.isReadOnly.value) return
      ymeta.set('language', v)
      if (tokenState.isOwner.value) persistDocContext({ language: v })
    }
  })

  const docSizeWarning = computed(() => computeDocSizeWarning(sync.docSizeBytes.value))

  // Initial connect. Password-protected / private docs must NOT connect until
  // the user unlocks them, otherwise content syncs before the gate appears.
  tokenState.fetchToken().then(() => {
    applySessionAwareness()
    // Seed the local theme ref from the DB-stored value so the preview can
    // paint with the right page size/colors before sync settles. If the
    // owner edits the theme later, that overwrites ymeta and broadcasts.
    if (tokenState.initialTheme.value && isValidTheme(tokenState.initialTheme.value)) {
      _themeRef.value = tokenState.initialTheme.value
    }
    // Seed the document context refs from the /token round-trip so the
    // Document tab + AI prompt builder see real values before sync
    // settles. Once Y.js sync delivers the ymeta values, the observer
    // above takes over.
    _descriptionRef.value = tokenState.initialDescription.value
    _audienceRef.value = tokenState.initialAudience.value
    _languageRef.value = tokenState.initialLanguage.value
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
    workspaceId: readonly(tokenState.workspaceId),
    workspaceRole: readonly(tokenState.workspaceRole),
    workspaceAiEnabled: readonly(tokenState.workspaceAiEnabled),
    workspaceBillingOwner: readonly(tokenState.workspaceBillingOwner),
    docSizeBytes: readonly(sync.docSizeBytes),
    docSizeWarning,
    undoManager,
    title,
    theme,
    description,
    audience,
    language,
    canEditTheme: readonly(canEditTheme),
    setTheme,
    resetTheme,
    onPasswordVerified,
    setAccessMode: tokenState.setAccessMode,
    destroy
  }
}
