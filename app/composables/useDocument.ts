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
import { normalizeAwarenessStates, normalizeAwarenessUser } from '~~/shared/utils/awarenessUser'
import { clampMetaString } from '~~/shared/utils/ymetaValidation'

/**
 * Thin orchestrator that wires together the three sub-composables a document
 * needs:
 *   - `useDocToken`       — /token fetch, access-mode, password-unlock flow
 *   - `useHocuspocusSync` — provider lifecycle, status/synced/userCount
 *   - (owned here)        — Y.Doc itself, title bridge, deletion observer,
 *                           awareness bootstrap, template seeding
 *
 * External API must stay bit-for-bit stable — `EditorLayout.vue` destructures
 * 17 fields from this return.
 */
export function useDocument(docId: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap('meta')

  // Test-only handle: when `public.exposeTestHandles` is true,
  // expose ydoc + ytext on `window.__DEBUG_*` so e2e flow tests can
  // assert against authoritative Y.Doc state instead of CM6's
  // viewport-virtualised .cm-content. The runtime config flag is
  // false by default — only the flow-test stack flips it to true via
  // NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1 (see scripts/flows-ephemeral.
  // ts). Production bundles never carry the handles.
  if (import.meta.client && useRuntimeConfig().public.exposeTestHandles) {
    type Win = {
      __DEBUG_ydoc?: Y.Doc
      __DEBUG_ytext?: Y.Text
      __DEBUG_awareness?: Awareness
    }
    const w = globalThis as unknown as Win
    w.__DEBUG_ydoc = ydoc
    w.__DEBUG_ytext = ytext
    // awareness is initialised below; stamp the handle there too
    // (search for `__DEBUG_awareness` to find the second write).
  }

  // Single stable Awareness instance — passed to HocuspocusProvider so both
  // local and remote clients share the same object. Components (PresenceBar,
  // yCollab) bind to this once at mount and never need to re-subscribe.
  const awareness = new Awareness(ydoc)

  // Normalise every remote peer's `user` field (name / colour / avatar
  // seed / id) the moment it arrives, before anything renders it. Registered
  // here — before yCollab and PresenceBar subscribe — so the y-codemirror
  // caret widget (which interpolates `color` into a raw style attribute)
  // and the presence bar only ever see the normalised shape. The sync
  // server normalises too; this is the client-side half of that guard.
  awareness.on('change', ({ added, updated }: { added: number[], updated: number[] }) => {
    normalizeAwarenessStates(awareness, [...added, ...updated])
  })

  // Expose awareness alongside the ydoc test handle (gated on the
  // same exposeTestHandles flag). Flow tests use it to assert
  // peer-state propagation (e.g. waiting for the local user.id to
  // be stamped before submitting an @markoto comment).
  if (import.meta.client && useRuntimeConfig().public.exposeTestHandles) {
    type Win = { __DEBUG_awareness?: Awareness }
    ;(globalThis as unknown as Win).__DEBUG_awareness = awareness
  }

  const undoManager = new Y.UndoManager(ytext)

  const { loggedIn, user: sessionUser } = useUserSession()

  // Access-mode / password / ownership state.
  const tokenState = useDocToken(docId)

  // Provider lifecycle. Reads the token lazily via `getToken` so the
  // post-password-verify reconnect picks up the fresh JWT automatically.
  //
  // Sync URL resolution:
  //   - In prod the runtime config carries `wss://sync.<domain>` from
  //     `NUXT_PUBLIC_SYNC_URL`. Pass through.
  //   - In dev the env default `ws://localhost:4001` only works when the
  //     browser is loading from localhost itself; opening the page from
  //     another device on the LAN (or via the host's LAN IP) would
  //     leave the WS pointing at the *browser's* localhost, where no
  //     sync server is listening, and the doc shows "Disconnected".
  //     Derive the URL from `window.location.host` instead — same host
  //     as the page, port 4001, matching scheme (ws/wss). Works for
  //     localhost, LAN IPs, and any hostname dev mode happens to be
  //     served on.
  const syncUrl = (() => {
    const configured = useRuntimeConfig().public.syncUrl
    if (import.meta.server || !configured) return configured
    if (configured.startsWith('ws://localhost:') || configured.startsWith('ws://127.0.0.1:')) {
      const port = configured.split(':').pop() || '4001'
      const scheme = globalThis.location.protocol === 'https:' ? 'wss' : 'ws'
      return `${scheme}://${globalThis.location.hostname}:${port}`
    }
    return configured
  })()
  const sync = useHocuspocusSync({
    docId,
    ydoc,
    awareness,
    syncUrl,
    // Refreshing accessor — the provider calls this on every reconnect;
    // it refetches a fresh JWT when the current one is near expiry so a
    // >2h session doesn't reconnect with a dead token (F5).
    getToken: () => tokenState.getFreshToken(),
    onSynced: () => {
      // Authoritative empty-doc seed. `onSynced` means we've received the
      // server's current state for this doc, so `ytext.length === 0` here
      // definitively means the server has NO content — safe to seed the
      // template body. This is the ONLY seed path (F9): we
      // deliberately do NOT seed on a never-synced disconnect. The
      // genuinely-serverless dev path (no syncUrl) still seeds because
      // `connect()` routes it through `onSynced`.
      insertTemplateIfEmpty()
      // If this sync came after password verification, now it's safe to show
      // the editor content — flipping `requiresPassword` false causes the
      // template's `v-if` gate to mount the editor.
      tokenState.clearPendingUnlock()
    },
    // No `onDisconnect` seed (F9 fix). A disconnect BEFORE any sync means we
    // never learned the server's content, so seeding a template would write a
    // local update that merges with the server's real content once the
    // provider auto-reconnects and finally syncs — silently corrupting the
    // document. An unreachable server shows an empty editor + a
    // "disconnected" status instead: honest and non-destructive. The doc
    // seeds correctly if/when a real sync lands and finds it empty.
    onAuthFailed: () => {
      tokenState.markReadOnly()
    }
  })

  function insertTemplateIfEmpty() {
    // Template body (server pre-rendered with the doc's title/description,
    // locale-matched on doc.language). `blank` renders to null: a blank
    // document stays empty — no generic welcome text any more (the Demo
    // template carries the onboarding content instead).
    const seed = tokenState.initialBody.value
    if (seed && ytext.length === 0 && !tokenState.isReadOnly.value) {
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
    // Normalised before broadcast so the shape we send is exactly what
    // peers (and the sync server) accept: a long OAuth display name is
    // capped. Avatars are generated locally — signed-in users from their
    // `id`, anonymous visitors from a random per-tab `avatarSeed`
    // (sessionStorage, `utils/userAvatar.ts`), so collaborators can tell
    // them apart. No image URL is ever broadcast.
    awareness.setLocalStateField('user', normalizeAwarenessUser({
      // Seed `id` from the session so remote clients can match this awareness
      // state to a workspace-member row (role tooltips, "is this person live"
      // lookup in PresenceBar). Unauthenticated visitors stay id-less and
      // appear as "Anonymous editor" downstream.
      id: loggedIn.value ? sessionUser.value?.id : undefined,
      name: loggedIn.value ? sessionUser.value?.name : generateRandomName(),
      color: pickColor(),
      avatarSeed: loggedIn.value ? undefined : getAnonAvatarToken()
    }))
  }

  // Bridge Y.js Map reactivity to Vue: `ymeta.get()` isn't tracked by Vue,
  // so we observe the Map and update a reactive ref on every change.
  // Live title from ymeta. Empty until a client sets one — a doc created
  // through the new-document dialog carries its title only on the DB row
  // (seeded below via /token), so the computed `title` falls back to it.
  const _ymetaTitleRef = ref((ymeta.get('title') as string) || '')
  // `_deleted` flag is set by the sync-server when the owner deletes the doc —
  // all connected clients see this via Y.js broadcast and redirect away.
  const isDeleted = ref(!!ymeta.get('_deleted'))
  // True while THIS client's own delete request is in flight (File →
  // Delete). The sync server broadcasts `_deleted` before the DELETE
  // response lands, so without this the person deleting the doc was told
  // "This document was deleted by the owner."
  const deletingHere = ref(false)
  const deletedByOther = computed(() => isDeleted.value && !deletingHere.value)
  function setDeletingHere(active: boolean) {
    deletingHere.value = active
  }
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
    _ymetaTitleRef.value = (ymeta.get('title') as string) || ''
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
    get: () => _ymetaTitleRef.value || tokenState.initialTitle.value || 'Untitled',
    set: (v: string) => {
      // Clamped to the sync server's ymeta bounds — an over-long value
      // would be rejected there and close the connection.
      if (!tokenState.isReadOnly.value) ymeta.set('title', clampMetaString('title', v))
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
  //
  // Changes are MERGED before the debounced PUT: `useDebounceFn` only
  // runs the last call's arguments, so setting the audience and then the
  // language within 800 ms used to persist only the language — the AI
  // (which reads these fields from the row) never saw the audience.
  type DocContextPatch = { description?: string, audience?: string, language?: string, templateId?: string }
  let pendingDocContext: DocContextPatch = {}
  const flushDocContext = useDebounceFn(() => {
    const body = pendingDocContext
    pendingDocContext = {}
    $fetch(`/api/docs/${docId}/meta`, {
      method: 'PUT',
      body
    }).catch(() => {})
  }, 800)
  function persistDocContext(next: DocContextPatch) {
    pendingDocContext = { ...pendingDocContext, ...next }
    flushDocContext()
  }

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
      const next = clampMetaString('description', v)
      ymeta.set('description', next)
      if (tokenState.isOwner.value) persistDocContext({ description: next })
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
      const next = clampMetaString('language', v)
      ymeta.set('language', next)
      if (tokenState.isOwner.value) persistDocContext({ language: next })
    }
  })

  /**
   * Template the doc started from. Not in ymeta (it only seeds the first
   * body); the Markdown import restores it from the file's frontmatter,
   * persisted for owners like the other context fields.
   */
  function setTemplateId(next: string) {
    if (tokenState.isReadOnly.value) return
    tokenState.templateId.value = next
    if (tokenState.isOwner.value) persistDocContext({ templateId: next })
  }

  const docSizeWarning = computed(() => computeDocSizeWarning(sync.docSizeBytes.value))

  // Initial connect. Password-protected / private docs must NOT connect until
  // the user unlocks them, otherwise content syncs before the gate appears.
  // Seed the local theme + document-context refs from the DB-stored
  // values (the /token round-trip, or /meta after a password unlock) so
  // the preview and the Document tab paint with real values before sync
  // settles. Once Y.js sync delivers the ymeta values, the observers
  // above take over.
  function applyInitialSeeds() {
    if (tokenState.initialTheme.value && isValidTheme(tokenState.initialTheme.value)) {
      _themeRef.value = tokenState.initialTheme.value
    }
    _descriptionRef.value = tokenState.initialDescription.value
    _audienceRef.value = tokenState.initialAudience.value
    _languageRef.value = tokenState.initialLanguage.value
  }

  tokenState.fetchToken().then(() => {
    applySessionAwareness()
    applyInitialSeeds()
    // Don't connect for docs we can't/shouldn't sync: password-gated
    // (no token yet), forbidden (no token, ever), or not-found (the doc
    // doesn't exist — an empty-token connect would just churn + fail).
    if (!tokenState.requiresPassword.value && !tokenState.forbidden.value && !tokenState.notFound.value) {
      sync.connect()
    }
  })

  /**
   * Called by PasswordModal. Updates the token in place, then reconnects the
   * provider with the new JWT. `requiresPassword` stays true until the first
   * sync completes — see `onSynced` above.
   */
  async function onPasswordVerified(newToken: string) {
    // A gated visitor's /token carried no metadata; fetch it with the
    // unlock JWT and seed before the provider reconnects.
    await tokenState.hydrateAfterUnlock(newToken)
    applyInitialSeeds()
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
    syncAuthFailed: readonly(tokenState.syncAuthFailed),
    syncRejection: readonly(sync.syncRejection),
    isOwner: readonly(tokenState.isOwner),
    /** The doc has an owner account (false = created anonymously). */
    hasOwner: readonly(tokenState.hasOwner),
    canDelete: readonly(tokenState.canDelete),
    isDeleted: readonly(isDeleted),
    deletedByOther,
    setDeletingHere,
    requiresPassword: readonly(tokenState.requiresPassword),
    forbidden: readonly(tokenState.forbidden),
    notFound: readonly(tokenState.notFound),
    accessMode: readonly(tokenState.accessMode),
    workspaceId: readonly(tokenState.workspaceId),
    workspaceRole: readonly(tokenState.workspaceRole),
    workspaceAiEnabled: readonly(tokenState.workspaceAiEnabled),
    /** The doc's plan includes custom CSS (else it is kept but not applied). */
    customCssAllowed: readonly(tokenState.customCssAllowed),
    workspaceBillingOwner: readonly(tokenState.workspaceBillingOwner),
    docSizeBytes: readonly(sync.docSizeBytes),
    docSizeWarning,
    undoManager,
    title,
    theme,
    description,
    audience,
    language,
    templateId: readonly(tokenState.templateId),
    setTemplateId,
    canEditTheme: readonly(canEditTheme),
    setTheme,
    resetTheme,
    onPasswordVerified,
    setAccessMode: tokenState.setAccessMode,
    // Doc JWT for HTTP calls made on behalf of a session-less viewer (the
    // preview's image-token fetch). Empty when there is none.
    getDocJwt: () => tokenState.getFreshToken(),
    destroy
  }
}
