import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { docSizeWarning as computeDocSizeWarning } from '~~/shared/utils/documents/documentHelpers'
import { normalizeAwarenessStates, normalizeAwarenessUser } from '~~/shared/utils/documents/awarenessUser'
import { useDocumentMeta } from './documentMeta'
import { createHiddenTabPause } from '~/utils/collab/hiddenTabPause'
import { TEMPLATE_SEED_ORIGIN } from '~/utils/editor/collabHistory'
import { SUGGEST_ORIGIN } from '~/composables/suggestions/useSuggestions'
import { suggestionsMap } from '~~/shared/utils/suggestions/ySuggestions'

/**
 * The sync server URL as this browser reaches it. A configured
 * `ws://localhost:<port>` (the dev default) would point at the *browser's*
 * localhost when the page is opened from another device, so it is rewritten
 * to the page's hostname with the same port and matching ws/wss scheme. Any
 * other configured URL (prod `wss://sync.<domain>`) is used as is.
 */
function resolveSyncUrl(): string {
  const configured = useRuntimeConfig().public.syncUrl
  if (import.meta.server || !configured) return configured
  if (configured.startsWith('ws://localhost:') || configured.startsWith('ws://127.0.0.1:')) {
    const port = configured.split(':').pop() || '4001'
    const scheme = globalThis.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${globalThis.location.hostname}:${port}`
  }
  return configured
}

/**
 * Test-only: with `public.exposeTestHandles` (NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1,
 * set only by the flow-test stack) ydoc, ytext and awareness go on
 * `window.__DEBUG_*` so e2e tests can assert on Y.Doc state instead of CM6's
 * viewport-virtualised .cm-content, and on peer-state propagation (e.g.
 * waiting for the local user.id before submitting an @markoto comment).
 */
function exposeTestHandles(ydoc: Y.Doc, ytext: Y.Text, awareness: Awareness): void {
  if (!import.meta.client || !useRuntimeConfig().public.exposeTestHandles) return
  type Win = {
    __DEBUG_ydoc?: Y.Doc
    __DEBUG_ytext?: Y.Text
    __DEBUG_awareness?: Awareness
  }
  const w = globalThis as unknown as Win
  w.__DEBUG_ydoc = ydoc
  w.__DEBUG_ytext = ytext
  w.__DEBUG_awareness = awareness
}

/**
 * The local user as peers see it. Normalised before broadcast so peers and
 * the sync server accept it (e.g. long OAuth display names are capped).
 * Avatars are generated locally: signed-in users from their `id`, anonymous
 * visitors from a random per-tab `avatarSeed` (`utils/userAvatar.ts`). No
 * image URL is ever broadcast.
 */
function applySessionAwareness(awareness: Awareness, loggedIn: boolean, user: { id?: number, name?: string } | null | undefined): void {
  awareness.setLocalStateField('user', normalizeAwarenessUser({
    // `id` lets peers match this state to a workspace-member row (role
    // tooltips, live lookup in PresenceBar). Anonymous visitors stay id-less.
    id: loggedIn ? user?.id : undefined,
    name: loggedIn ? user?.name : generateRandomName(),
    color: pickColor(),
    avatarSeed: loggedIn ? undefined : getAnonAvatarToken()
  }))
}

/** One stable instance, so components (PresenceBar, yCollab) bind once and never re-subscribe. */
function createAwareness(ydoc: Y.Doc): Awareness {
  const awareness = new Awareness(ydoc)
  // Normalise every remote peer's `user` field on arrival. Registered before
  // yCollab and PresenceBar subscribe, because the y-codemirror caret widget
  // interpolates `color` into a raw style attribute. The sync server
  // normalises too; this is the client-side half.
  awareness.on('change', ({ added, updated }: { added: number[], updated: number[] }) => {
    normalizeAwarenessStates(awareness, [...added, ...updated])
  })
  return awareness
}

/**
 * Release the sync connection while the tab is hidden and take it up again
 * when it is shown (`utils/collab/hiddenTabPause.ts`). Meanwhile the user's
 * awareness state carries `away: true`, which PresenceBar shows. Returns
 * the teardown.
 */
function watchHiddenTab(sync: ReturnType<typeof useHocuspocusSync>, awareness: Awareness): () => void {
  if (!import.meta.client || typeof document === 'undefined') return () => {}
  const controller = createHiddenTabPause({
    isHidden: () => document.visibilityState === 'hidden',
    canPause: () => sync.status.value === 'connected' && sync.synced.value && sync.pendingChanges.value === 0,
    pause: () => sync.pause(),
    resume: () => sync.resume(),
    setAway: away => awareness.setLocalStateField('away', away)
  }, Number(useRuntimeConfig().public.syncHiddenDisconnectMs) || 0)
  const onVisibilityChange = () => controller.onVisibilityChange()
  document.addEventListener('visibilitychange', onVisibilityChange)
  const stopWatch = watch([sync.status, sync.synced, sync.pendingChanges], () => controller.check())
  // A tab opened in the background starts hidden.
  controller.onVisibilityChange()
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stopWatch()
    controller.dispose()
  }
}

/**
 * Thin orchestrator that wires together the three sub-composables a document
 * needs:
 *   - `useDocToken`      : /token fetch, access-mode, password-unlock flow
 *   - `useHocuspocusSync`: provider lifecycle, status/synced/userCount
 *   - (owned here)       : Y.Doc itself, title bridge, deletion observer,
 *                           awareness bootstrap, template seeding
 *
 * The return shape is consumed by `EditorLayout.vue`; keep it stable.
 */
export function useDocument(docId: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap('meta')
  const awareness = createAwareness(ydoc)
  exposeTestHandles(ydoc, ytext, awareness)

  // Tracks this tab's own edits only: synced and AI updates carry the
  // provider as origin, the template seed its own origin. Suggestions made
  // in suggesting mode are this tab's edits too: undo takes them back.
  const undoManager = new Y.UndoManager([ytext, suggestionsMap(ydoc)], { trackedOrigins: new Set([null, SUGGEST_ORIGIN]) })

  const { loggedIn, user: sessionUser } = useUserSession()

  const tokenState = useDocToken(docId)

  // The token is read lazily via `getToken` so the post-password-verify
  // reconnect picks up the fresh JWT.
  const syncUrl = resolveSyncUrl()
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

  const stopHiddenTabWatch = watchHiddenTab(sync, awareness)

  function insertTemplateIfEmpty() {
    // Server pre-rendered with the doc's title/description, locale-matched
    // on doc.language; `blank` renders to null and the document stays empty.
    const seed = tokenState.initialBody.value
    if (seed && ytext.length === 0 && !tokenState.isReadOnly.value && !tokenState.suggestOnly.value) {
      // Not undoable: undo must never take back the starting text.
      ydoc.transact(() => ytext.insert(0, seed), TEMPLATE_SEED_ORIGIN)
    }
  }

  // Placeholder so yCollab (which may attach before the token resolves) has
  // something to show; `applySessionAwareness` sets the real values.
  awareness.setLocalStateField('user', {
    name: generateRandomName(),
    color: pickColor()
  })

  const meta = useDocumentMeta(docId, ymeta, tokenState)
  const bibliography = useBibliography(ydoc, ymeta, tokenState.isReadOnly)

  const docSizeWarning = computed(() => computeDocSizeWarning(sync.docSizeBytes.value))

  // fetchToken reports its own failures through `status`; it does not reject.
  void tokenState.fetchToken().then(() => {
    applySessionAwareness(awareness, loggedIn.value, sessionUser.value)
    meta.applyInitialSeeds()
    // Password-gated docs must not connect before unlock (content would sync
    // before the gate shows); forbidden and not-found docs have nothing to sync.
    if (!tokenState.requiresPassword.value && !tokenState.forbidden.value && !tokenState.notFound.value) {
      sync.connect()
    }
  })

  /**
   * Called by PasswordModal. Updates the token in place, then reconnects the
   * provider with the new JWT. `requiresPassword` stays true until the first
   * sync completes: see `onSynced` above.
   */
  async function onPasswordVerified(newToken: string) {
    // A gated visitor's /token carried no metadata; fetch it with the
    // unlock JWT and seed before the provider reconnects.
    await tokenState.hydrateAfterUnlock(newToken)
    meta.applyInitialSeeds()
    tokenState.onPasswordVerified(newToken)
    sync.reconnect()
  }

  function destroy() {
    stopAccessWatch()
    stopHiddenTabWatch()
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
    /** Edits can only be suggestions (the document requires it, or a viewer may suggest). */
    suggestOnly: readonly(tokenState.suggestOnly),
    /** The document requires suggestion mode of everyone not exempt. */
    suggestionsRequired: readonly(tokenState.suggestionsRequired),
    /** Holds the content-write right (an editor, also when made to suggest). */
    contentWriter: readonly(tokenState.contentWriter),
    syncAuthFailed: readonly(tokenState.syncAuthFailed),
    syncRejection: readonly(sync.syncRejection),
    /** The sync server is at a capacity limit; the connection retries by itself. */
    syncBusy: readonly(sync.syncBusy),
    isOwner: readonly(tokenState.isOwner),
    /** The doc has an owner account (false = created anonymously). */
    hasOwner: readonly(tokenState.hasOwner),
    canDelete: readonly(tokenState.canDelete),
    isDeleted: readonly(meta.isDeleted),
    deletedByOther: meta.deletedByOther,
    setDeletingHere: meta.setDeletingHere,
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
    title: meta.title,
    theme: meta.theme,
    description: meta.description,
    audience: meta.audience,
    language: meta.language,
    /** The document's bibliography and citation style (Y.js). */
    bibliography,
    templateId: readonly(tokenState.templateId),
    setTemplateId: meta.setTemplateId,
    canEditTheme: readonly(meta.canEditTheme),
    setTheme: meta.setTheme,
    resetTheme: meta.resetTheme,
    onPasswordVerified,
    setAccessMode: tokenState.setAccessMode,
    // Doc JWT for HTTP calls on behalf of a session-less viewer (the preview's
    // image-token fetch). Empty when there is none.
    getDocJwt: () => tokenState.getFreshToken(),
    destroy
  }
}
