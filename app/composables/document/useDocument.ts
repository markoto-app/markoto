import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'
import {
  readThemeFromYmeta,
  canEditTheme as computeCanEditTheme,
  docSizeWarning as computeDocSizeWarning
} from '~~/shared/utils/documents/documentHelpers'
import { normalizeAwarenessStates, normalizeAwarenessUser } from '~~/shared/utils/documents/awarenessUser'
import { clampMetaString } from '~~/shared/utils/documents/ymetaValidation'

/**
 * Thin orchestrator that wires together the three sub-composables a document
 * needs:
 *   - `useDocToken`       — /token fetch, access-mode, password-unlock flow
 *   - `useHocuspocusSync` — provider lifecycle, status/synced/userCount
 *   - (owned here)        — Y.Doc itself, title bridge, deletion observer,
 *                           awareness bootstrap, template seeding
 *
 * The return shape is consumed by `EditorLayout.vue`; keep it stable.
 */
export function useDocument(docId: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap('meta')

  // Test-only: with `public.exposeTestHandles` (NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1,
  // set only by the flow-test stack) ydoc + ytext go on `window.__DEBUG_*` so
  // e2e tests can assert on Y.Doc state instead of CM6's viewport-virtualised
  // .cm-content.
  if (import.meta.client && useRuntimeConfig().public.exposeTestHandles) {
    type Win = {
      __DEBUG_ydoc?: Y.Doc
      __DEBUG_ytext?: Y.Text
      __DEBUG_awareness?: Awareness
    }
    const w = globalThis as unknown as Win
    w.__DEBUG_ydoc = ydoc
    w.__DEBUG_ytext = ytext
  }

  // One stable instance, so components (PresenceBar, yCollab) bind once and never re-subscribe.
  const awareness = new Awareness(ydoc)

  // Normalise every remote peer's `user` field on arrival. Registered before
  // yCollab and PresenceBar subscribe, because the y-codemirror caret widget
  // interpolates `color` into a raw style attribute. The sync server
  // normalises too; this is the client-side half.
  awareness.on('change', ({ added, updated }: { added: number[], updated: number[] }) => {
    normalizeAwarenessStates(awareness, [...added, ...updated])
  })

  // Test handle for asserting peer-state propagation (e.g. waiting for the
  // local user.id before submitting an @markoto comment).
  if (import.meta.client && useRuntimeConfig().public.exposeTestHandles) {
    type Win = { __DEBUG_awareness?: Awareness }
    ;(globalThis as unknown as Win).__DEBUG_awareness = awareness
  }

  const undoManager = new Y.UndoManager(ytext)

  const { loggedIn, user: sessionUser } = useUserSession()

  const tokenState = useDocToken(docId)

  // The token is read lazily via `getToken` so the post-password-verify
  // reconnect picks up the fresh JWT.
  //
  // A configured `ws://localhost:<port>` (the dev default) would point at the
  // *browser's* localhost when the page is opened from another device, so it
  // is rewritten to the page's hostname with the same port and matching
  // ws/wss scheme. Any other configured URL (prod `wss://sync.<domain>`) is
  // used as is.
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
  // One silent retry with a refetched token per sync (see onAuthFailed).
  let authRetried = false
  const sync = useHocuspocusSync({
    docId,
    ydoc,
    awareness,
    syncUrl,
    // Called on every reconnect and when the sync server asks for a fresh
    // token before expiry, so a >2h session neither reconnects with a dead
    // token nor gets closed at expiry.
    getToken: opts => tokenState.getFreshToken(opts),
    onReauthRequired: () => tokenState.invalidateToken(),
    onSynced: () => {
      authRetried = false
      // The ONLY template seed path. After a sync, an empty ytext means the
      // server really has no content. Never seed on a never-synced
      // disconnect: the local update would merge with the server's real
      // content on reconnect and corrupt the document. (The serverless dev
      // path without syncUrl also seeds, since `connect()` routes it here.)
      insertTemplateIfEmpty()
      // After a password unlock it is now safe to mount the editor.
      tokenState.clearPendingUnlock()
    },
    onAuthFailed: () => {
      // Access ended and the gate is already showing: nothing to report.
      if (accessEnded()) return
      // A refused token may just be outdated (access changed while offline,
      // clock skew): retry once with a fresh token before showing the banner.
      // A refused socket can't authenticate again, hence a new provider.
      if (!authRetried) {
        authRetried = true
        tokenState.invalidateToken()
        // Not from inside the provider's own event dispatch.
        queueMicrotask(() => sync.reconnect())
        return
      }
      tokenState.markReadOnly()
    }
  })

  function accessEnded(): boolean {
    return tokenState.forbidden.value
      || (tokenState.requiresPassword.value && !tokenState.pendingPasswordUnlock.value)
  }

  // Access can end while the editor is open (the token refetch on a
  // renewal or re-authentication found no token). Drop the connection so
  // the provider stops presenting a token the server refuses; a password
  // unlock reconnects with a new provider.
  const stopAccessWatch = watch(accessEnded, (ended) => {
    if (ended) sync.disconnect()
  })

  function insertTemplateIfEmpty() {
    // Server pre-rendered with the doc's title/description, locale-matched
    // on doc.language; `blank` renders to null and the document stays empty.
    const seed = tokenState.initialBody.value
    if (seed && ytext.length === 0 && !tokenState.isReadOnly.value) {
      ytext.insert(0, seed)
    }
  }

  // Placeholder so yCollab (which may attach before the token resolves) has
  // something to show; `applySessionAwareness` sets the real values.
  awareness.setLocalStateField('user', {
    name: generateRandomName(),
    color: pickColor()
  })

  function applySessionAwareness() {
    // Normalised before broadcast so peers and the sync server accept it
    // (e.g. long OAuth display names are capped). Avatars are generated
    // locally: signed-in users from their `id`, anonymous visitors from a
    // random per-tab `avatarSeed` (`utils/userAvatar.ts`). No image URL is
    // ever broadcast.
    awareness.setLocalStateField('user', normalizeAwarenessUser({
      // `id` lets peers match this state to a workspace-member row (role
      // tooltips, live lookup in PresenceBar). Anonymous visitors stay id-less.
      id: loggedIn.value ? sessionUser.value?.id : undefined,
      name: loggedIn.value ? sessionUser.value?.name : generateRandomName(),
      color: pickColor(),
      avatarSeed: loggedIn.value ? undefined : getAnonAvatarToken()
    }))
  }

  // `ymeta.get()` isn't tracked by Vue, so the Map is observed below and
  // mirrored into refs. The live title is empty until a client sets one: a
  // doc created via the new-document dialog carries it only on the DB row
  // (from /token), which the computed `title` falls back to.
  const _ymetaTitleRef = ref((ymeta.get('title') as string) || '')
  // Set by the sync server when the owner deletes the doc; every connected client redirects away.
  const isDeleted = ref(!!ymeta.get('_deleted'))
  // True while THIS client's own delete request is in flight. The sync server
  // broadcasts `_deleted` before the DELETE response lands, so without this
  // the deleter would see "deleted by the owner".
  const deletingHere = ref(false)
  const deletedByOther = computed(() => isDeleted.value && !deletingHere.value)
  function setDeletingHere(active: boolean) {
    deletingHere.value = active
  }
  // The theme lives on ymeta.theme as plain JSON so it broadcasts like the
  // title; `defaultTheme` until /token seeds the DB value or sync delivers it.
  const _themeRef = ref<DocTheme>(defaultTheme)
  // Document context: same dual source as the theme (/token first, then ymeta).
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
      // Clamped to the sync server's ymeta bounds; an over-long value would close the connection.
      if (!tokenState.isReadOnly.value) ymeta.set('title', clampMetaString('title', v))
    }
  })

  /**
   * Read-only: no. Owned by someone else: no. Ownerless (anonymous-created):
   * yes, matching its open-edit content. `PUT /meta` is owner-gated, so
   * ownerless docs skip persisting and rely on Y.js sync alone.
   */
  const canEditTheme = computed(() => computeCanEditTheme({
    isReadOnly: tokenState.isReadOnly.value,
    isOwner: tokenState.isOwner.value,
    hasOwner: tokenState.hasOwner.value
  }))

  /**
   * The DB write (debounced PUT /meta, owned docs only) is a best-effort
   * seed so a fresh visitor sees the right theme before y-postgresql
   * replays the update history; Y.js stays the live source of truth.
   */
  const persistTheme = useDebounceFn((next: DocTheme) => {
    $fetch(`/api/docs/${docId}/meta`, {
      method: 'PUT',
      body: { theme: next }
    }).catch(() => {})
  }, 800)

  // Same pattern as `persistTheme`: owner-only DB writes; non-owners on
  // open-edit docs still change ymeta, and Y.js sync is then the only
  // persistence.
  //
  // Changes are MERGED before the debounced PUT because `useDebounceFn` only
  // runs the last call's arguments: setting audience then language within
  // 800 ms would otherwise persist only the language, and the AI reads
  // these fields from the row.
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

  // Clears the ymeta entry and, for owned docs, nulls the DB column; everyone falls back to `defaultTheme`.
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

  // Same write semantics as the theme: editors change them, viewers cannot.
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

  // Seeds the theme + document-context refs from the DB values (/token, or
  // /meta after a password unlock) so the preview and Document tab paint
  // before sync settles; the ymeta observers take over afterwards.
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
    // Password-gated docs must not connect before unlock (content would sync
    // before the gate shows); forbidden and not-found docs have nothing to sync.
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
    stopAccessWatch()
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
    /** The doc's plan includes custom CSS (else it is kept but not applied). */
    customCssAllowed: readonly(tokenState.customCssAllowed),
    brandFonts: readonly(tokenState.brandFonts),
    brandLockedTheme: readonly(tokenState.brandLockedTheme),
    noDownload: readonly(tokenState.noDownload),
    shareExpired: readonly(tokenState.shareExpired),
    workspacePlan: readonly(tokenState.workspacePlan),
    ssoLoginUrl: readonly(tokenState.ssoLoginUrl),
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
    // Doc JWT for HTTP calls on behalf of a session-less viewer (the preview's
    // image-token fetch). Empty when there is none.
    getDocJwt: () => tokenState.getFreshToken(),
    destroy
  }
}
