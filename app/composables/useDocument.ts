import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'

export function useDocument(docId: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap('meta')

  const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
  const synced = ref(false)
  const userCount = ref(1)
  const isReadOnly = ref(false)
  const isOwner = ref(false)
  const requiresPassword = ref(false)
  // True when the doc is private and the caller isn't the owner. Same treatment
  // as `requiresPassword` (no token issued, no Hocuspocus connection), but with
  // no way to unlock from the client — you either log in as the owner or don't
  // get to see it. The UI renders a dedicated lock screen for this case.
  const forbidden = ref(false)
  const accessMode = ref<string>('open-edit')
  const docSizeBytes = ref(0)
  const syncUrl = useRuntimeConfig().public.syncUrl

  const provider = ref<HocuspocusProvider | null>(null)
  // Single stable Awareness instance — passed to HocuspocusProvider so both
  // local and remote clients share the same object. Components (PresenceBar,
  // yCollab) bind to this once at mount and never need to re-subscribe.
  const awareness = new Awareness(ydoc)

  // Session info — declared early so connect() can reference it
  const { loggedIn, user: sessionUser } = useUserSession()

  // Token data from server (single endpoint provides token + meta)
  const tokenData = ref<{
    token: string
    readOnly: boolean
    requiresPassword?: boolean
    accessMode?: string
    ownerId?: number | null
  } | null>(null)

  async function fetchToken() {
    try {
      const data = await $fetch<{
        token: string | null
        readOnly: boolean
        requiresPassword?: boolean
        forbidden?: boolean
        accessMode: string
        ownerId: number | null
      }>(`/api/docs/${docId}/token`)

      tokenData.value = data as any
      isReadOnly.value = data.readOnly
      requiresPassword.value = !!data.requiresPassword
      forbidden.value = !!data.forbidden
      accessMode.value = data.accessMode

      // Check ownership with type-safe comparison
      const userId = sessionUser.value?.id
      isOwner.value = data.ownerId != null
        && typeof userId === 'number'
        && data.ownerId === userId
    } catch {
      tokenData.value = { token: '', readOnly: false }
    }
  }

  // Track whether we're waiting for post-password sync
  const pendingPasswordUnlock = ref(false)

  function onPasswordVerified(newToken: string) {
    // Don't clear requiresPassword yet — wait for sync so the editor
    // mounts with content already loaded (prevents empty doc + prepend bug)
    pendingPasswordUnlock.value = true
    isReadOnly.value = false
    tokenData.value = { token: newToken, readOnly: false }
    provider.value?.destroy()
    connect()
  }

  function insertWelcomeIfEmpty() {
    if (ytext.length === 0 && !isReadOnly.value) {
      ytext.insert(0, welcomeMarkdown)
    }
  }

  function connect() {
    if (!syncUrl) {
      status.value = 'disconnected'
      synced.value = true
      insertWelcomeIfEmpty()
      return
    }

    // Set awareness user info before connecting so the first sync includes it
    awareness.setLocalStateField('user', {
      name: loggedIn.value ? sessionUser.value?.name : generateRandomName(),
      color: pickColor(),
      avatar: sessionUser.value?.avatar
    })

    provider.value = new HocuspocusProvider({
      url: syncUrl,
      name: docId,
      document: ydoc,
      awareness,
      token: tokenData.value?.token || '',
      onConnect: () => { status.value = 'connected' },
      onDisconnect: () => {
        status.value = 'disconnected'
        if (!synced.value) insertWelcomeIfEmpty()
      },
      onSynced: () => {
        synced.value = true
        docSizeBytes.value = Y.encodeStateAsUpdate(ydoc).byteLength
        insertWelcomeIfEmpty()
        // If this sync came after password verification, now it's safe to show content
        if (pendingPasswordUnlock.value) {
          pendingPasswordUnlock.value = false
          requiresPassword.value = false
        }
      },
      onAuthenticationFailed: () => { isReadOnly.value = true },
      onAwarenessChange: ({ states }: { states: Map<number, any> }) => {
        userCount.value = states.size
      }
    })
  }

  // Set default awareness user info (will be overwritten in connect() with real user data)
  awareness.setLocalStateField('user', {
    name: generateRandomName(),
    color: pickColor()
  })

  const undoManager = new Y.UndoManager(ytext)

  // Bridge Y.js Map reactivity to Vue: ymeta.get() isn't tracked by Vue,
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
      if (!isReadOnly.value) ymeta.set('title', v)
    }
  })

  const docSizeWarning = computed(() => {
    const mb = docSizeBytes.value / (1024 * 1024)
    if (mb > 8) return 'critical'
    if (mb > 5) return 'warning'
    return null
  })

  // Single initialization: fetch token, then connect only if no password required.
  // Password-protected docs must NOT connect until password is verified —
  // otherwise the Y.js document syncs and content is visible behind the modal.
  fetchToken().then(() => {
    // Don't connect if the server declined to issue a token. Either the doc is
    // password-protected (PasswordModal will unlock it) or private (no unlock
    // path — the EditorLayout shows a lock screen).
    if (!requiresPassword.value && !forbidden.value) connect()
  })

  function destroy() {
    provider.value?.destroy()
    awareness.destroy()
    ydoc.destroy()
  }

  onUnmounted(() => {
    destroy()
  })

  // Update accessMode from outside (e.g. ShareModal changed it)
  function setAccessMode(mode: string) {
    accessMode.value = mode
  }

  return {
    ydoc,
    ytext,
    awareness,
    provider: readonly(provider),
    status: readonly(status),
    synced: readonly(synced),
    userCount: readonly(userCount),
    isReadOnly: readonly(isReadOnly),
    isOwner: readonly(isOwner),
    isDeleted: readonly(isDeleted),
    requiresPassword: readonly(requiresPassword),
    forbidden: readonly(forbidden),
    accessMode: readonly(accessMode),
    docSizeBytes: readonly(docSizeBytes),
    docSizeWarning,
    undoManager,
    title,
    onPasswordVerified,
    setAccessMode,
    destroy
  }
}
