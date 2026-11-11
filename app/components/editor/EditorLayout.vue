<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { insertTable } from '~/utils/editor/editorCommands'
import TableSizePicker from './TableSizePicker.vue'
import RightPanelHost from './RightPanelHost.vue'
import MobileTabBar from './MobileTabBar.vue'
import EditorCommandsPanel from './EditorCommandsPanel.vue'
import type { TabName } from './tabBarTypes'
import { useProvideComments } from '~/composables/comments/useComments'
import type { CommentRange } from '~/utils/comments/commentDecorations'
import type { ImportedDocProperties } from '~~/shared/utils/markdown/markdownFrontmatter'
import { customCssForPlan } from '~~/shared/utils/theme/themePresets'
import { applyBrandLock } from '~~/shared/utils/theme/brandLock'
import type { DocTheme } from '~~/shared/types/theme'

const props = defineProps<{
  docId: string
}>()

const { t } = useI18n()

const {
  ydoc,
  ytext,
  awareness,
  provider: _provider,
  status,
  synced,
  userCount,
  isReadOnly,
  syncAuthFailed,
  syncRejection,
  isOwner,
  hasOwner,
  canDelete,
  deletedByOther,
  setDeletingHere,
  requiresPassword,
  forbidden,
  notFound,
  accessMode,
  workspaceId: docWorkspaceId,
  workspaceRole: docWorkspaceRole,
  customCssAllowed,
  brandFonts,
  brandLockedTheme,
  noDownload,
  shareExpired,
  workspacePlan,
  ssoLoginUrl,
  undoManager,
  title,
  theme,
  description,
  audience,
  language,
  templateId,
  setTemplateId,
  canEditTheme,
  setTheme,
  resetTheme,
  onPasswordVerified,
  setAccessMode,
  getDocJwt
} = useDocument(props.docId)

// What the preview and browser print render. The author's custom CSS is
// dropped when the plan doesn't include it (a preset's template CSS stays,
// `customCssForPlan`); it stays in the theme and Y.js, so upgrading applies it
// again, and the server renderer drops it the same way (render-bootstrap).
// A locked workspace design (brand kit) replaces everything but the
// document's cover text, as in the server renderer (shared/utils/theme/brandLock.ts).
const renderTheme = computed(() => {
  const base = applyBrandLock(theme.value as DocTheme, brandLockedTheme.value as DocTheme | null)
  const css = customCssForPlan(base.customCss, customCssAllowed.value)
  return css === base.customCss ? base : { ...base, customCss: css }
})

// Whether the editor was ever focused this session. CM6's selection sits at 0
// by default, so without it every fresh doc would report "cursor on line 1" to
// the AI prompt path.
const editorEverFocused = ref(false)

// AI collaborator: joins the doc as its own Y.js client. `getEditorSelection`
// snapshots the caret/selection at submit time so the model can resolve
// "here" / "this" to a concrete location.
const ai = useAI(computed(() => props.docId), awareness, {
  getEditorSelection: () => snapshotEditorSelection(editorView.value, editorEverFocused.value)
})

const toast = useToast()
const { showError } = useErrorHandler()

// Live voice dictation: a WebSocket relay to Mistral Voxtral Realtime. Interim
// transcripts show as ghost text at the caret (`dictationExtensions.ts`),
// finalized phrases commit to Y.js there, and the awareness field `dictation`
// advertises the listening state to collaborators.
const dictation = useVoiceDictation({
  docId: computed(() => props.docId),
  onPartial: (text) => {
    const view = editorView.value
    if (!view) return
    view.dispatch({ effects: setDictationInterim.of(text) })
  },
  onFinal: (text) => {
    const view = editorView.value
    if (!view) return
    // Clear the ghost first so interim-to-final looks seamless.
    view.dispatch({ effects: setDictationInterim.of('') })
    const uid = (sessionUser.value?.id as number | undefined) ?? null
    commitDictationFinal(view, ydoc, ytext, uid, text)
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
  awareness.setLocalStateField('dictation', active ? { active: true } : null)
})

// Clear the ghost when recording stops: the composable owns the socket, only
// this layer knows the editor view.
watch(() => dictation.state.value, (s) => {
  if (s === 'idle' || s === 'error') {
    const view = editorView.value
    if (view) view.dispatch({ effects: setDictationInterim.of('') })
  }
})

const showShareModal = ref(false)
// Delete confirmation, under File → Delete (also reachable from Sharing).
const showDeleteModal = ref(false)
// Duplicate + Move modals under the File menu. The server re-checks authz,
// so the menu's canManage gate is UX-only.
const showDuplicateModal = ref(false)
const showMoveModal = ref(false)
// Owner or workspace admin; mirrors server-side canManageDoc. Editors and
// viewers can edit content (`!isReadOnly`) but not move the doc.
const canManageDoc = computed(() =>
  isOwner.value || docWorkspaceRole.value === 'admin'
)
const showImportModal = ref(false)
// Right-sidebar slot, mutually exclusive between activity, theme, knowledge,
// document, comments and the mobile-only "editor" drawer (command palette), so
// the layout shift is predictable. Knowledge only appears for workspace docs
// (`hasKnowledgeAccess`).
type RightSidebarPanel = TabName
const rightSidebar = ref<RightSidebarPanel | null>(null)
// Insert flows EditorCommandsPanel hands back to the layout (table-size picker, image picker).
function toggleSidebar(panel: RightSidebarPanel) {
  rightSidebar.value = rightSidebar.value === panel ? null : panel
}
function closeSidebar() {
  rightSidebar.value = null
}
// Receives the tapped tab from MobileTabBar and toggles its drawer. The mic
// tab is handled separately (toggle-dictation event).
function onMobileTabSelect(name: TabName) {
  toggleSidebar(name)
}

// Mobile drawer titles come from each panel's own header.

// Global Escape closes the open sidebar panel, except while a modal-like layer
// (delete/duplicate/move/import/share) is up: Nuxt UI modals own Escape in
// their stack, and it must not also reach the sidebar after dismissing the modal.
onKeyStroke('Escape', () => {
  if (
    showShareModal.value
    || showDeleteModal.value
    || showDuplicateModal.value
    || showMoveModal.value
    || showImportModal.value
  ) return
  if (rightSidebar.value) closeSidebar()
})

// One useComments instance at this level feeds both the sidebar panel (list +
// composer) and the editor decoration plugin (underlines); two instances would
// each observe Y.js and briefly disagree. createInjectionState provides and
// returns the api; CommentsPanel reads the same instance via useCommentsContext.
const commentsApi = useProvideComments(ydoc, awareness, props.docId)
const commentRanges = computed<CommentRange[]>(() =>
  commentsApi.comments.value
    .filter(c => c.anchor !== null && !c.resolved)
    .map(c => ({ id: c.id, from: c.anchor!.from, to: c.anchor!.to }))
)

// OS notification on replies to a thread I authored, only while the tab is
// hidden and permission is granted. Permission is asked lazily at the first
// such reply, not on page open.
useCommentNotifications({
  comments: commentsApi.comments,
  awareness,
  docTitle: title,
  docId: props.docId
})

// The parent calls `startDraft()` on `create-comment` (toolbar / menu) and
// `focusComment(id)` when the editor emits a click on a comment underline.
const commentsPanelRef = ref<{
  startDraft: () => boolean
  focusComment: (id: string) => void
} | null>(null)

// Comment underline click: open the panel, scroll the thread into view, flash the editor range.
function onCommentClickInEditor(id: string) {
  rightSidebar.value = 'comments'
  // Wait a tick so the panel mounts before it is asked to scroll.
  nextTick(() => {
    commentsPanelRef.value?.focusComment(id)
    flashEditorComment(id)
  })
}

// Toolbar / menu "Comment" starts a draft; the panel handles the "no selection" hint.
function triggerCreateComment() {
  if (isReadOnly.value) return
  rightSidebar.value = 'comments'
  nextTick(() => {
    commentsPanelRef.value?.startDraft()
  })
}

// The user clicked a thread: scroll the editor to it and flash the anchor.
function onCommentPanelFocus(id: string) {
  flashEditorComment(id)
}

function flashEditorComment(id: string) {
  const c = commentsApi.comments.value.find(x => x.id === id)
  if (!c?.anchor) return
  editorPaneRef.value?.flashCommentRange?.(c.anchor.from, c.anchor.to)
}
// Knowledge is workspace-level: standalone/anonymous docs have none, and
// non-members don't see the tab (`docWorkspaceRole` is non-null iff the viewer
// is a member).
const hasKnowledgeAccess = computed(() => Boolean(docWorkspaceId.value) && docWorkspaceRole.value !== null)

// AI availability + voice follow the document's workspace (a Team / Business
// plan may unlock what the personal plan doesn't).
const aiWorkspaceContext = useAiWorkspaceContext()
watch(() => (docWorkspaceRole.value !== null ? docWorkspaceId.value : null), (ws) => {
  aiWorkspaceContext.value = ws ?? null
}, { immediate: true })
onUnmounted(() => {
  aiWorkspaceContext.value = null
})
// Close the knowledge panel if the doc moves to a workspace the user isn't in
// (or out of one), so no empty column is left.
watch(hasKnowledgeAccess, (allowed) => {
  if (!allowed && rightSidebar.value === 'knowledge') rightSidebar.value = null
})
// Open while requiresPassword is true; closable only via verify/cancel.
const passwordModalOpen = ref(false)
watch(requiresPassword, (val) => {
  passwordModalOpen.value = val
}, { immediate: true })

// If someone else deleted the doc (e.g. the owner elsewhere), toast and
// redirect home. A deletion started here is handled by the delete modal
// (own toast + redirect), so the deleter never sees "deleted by the owner".
watch(deletedByOther, (deleted) => {
  if (!deleted) return
  toast.add({
    title: t('delete.remoteTitle'),
    description: t('delete.remoteDesc'),
    icon: 'i-lucide-trash-2',
    color: 'warning'
  })
  navigateTo('/')
})
// Drives the dropdown loader spinner.
const exporting = ref(false)
// Page count from the paged.js preview, shown in the status bar.
const pageCount = ref(0)

// Access-mode header button: closed lock when restricted (private or
// password-protected), open lock when anyone with the link gets in. A binary
// icon avoids clashing with nearby icons (the eye is the preview/split
// toggle); the tooltip says view-only vs open-edit.
const ACCESS_LABELS: Record<string, string> = {
  'private': 'share.private',
  'open-edit': 'share.openEdit',
  'open-view': 'share.openView',
  'password-protected': 'share.passwordProtected'
}
const LOCKED_MODES = new Set(['private', 'password-protected'])
const accessIcon = computed(() => LOCKED_MODES.has(accessMode.value) ? 'i-lucide-lock' : 'i-lucide-lock-open')
const accessLabelKey = computed(() => ACCESS_LABELS[accessMode.value] ?? 'share.openEdit')

// Share-link controls: a view-only link allows no print, PDF or Markdown
// download for this viewer (the server refuses the PDF too).
function refuseDownload(): boolean {
  if (!noDownload.value) return false
  toast.add({ title: t('share.controls.downloadDisabled'), icon: 'i-lucide-ban', color: 'neutral' })
  return true
}

async function exportPdf() {
  if (refuseDownload()) return
  exporting.value = true
  try {
    // Read fresh from ytext; the shallowRef may be stale after HMR.
    await printDocumentAsPdf({
      source: ytext.toString(),
      theme: renderTheme.value,
      title: title.value,
      docId: props.docId,
      language: language.value,
      getDocJwt,
      brandFonts: brandFonts.value
    })
  } catch (e) {
    showError('error.pdfExportFailedTitle', e)
  } finally {
    exporting.value = false
  }
}

// The file carries theme + document properties as YAML frontmatter
// (shared/utils/markdown/markdownFrontmatter.ts) so importing restores them.
async function exportMarkdown() {
  if (refuseDownload()) return
  const { buildMarkdownExport } = await import('~~/shared/utils/markdown/markdownFrontmatter')
  const content = buildMarkdownExport(textContent.value, {
    title: title.value,
    description: description.value,
    audience: audience.value,
    language: language.value,
    templateId: templateId.value,
    // Plain copy: the theme ref is a readonly proxy.
    theme: structuredClone(toRaw(theme.value)) as DocTheme
  })
  downloadMarkdown(content, title.value)
}

// Theme + properties from an imported markoto Markdown file. The server has
// validated every field (server/utils/documents/markdownImport.ts); the
// setters check again (setTheme: schema; ymeta: the sync server).
function applyImportedProperties(
  properties: ImportedDocProperties,
  notes: { ignored: string[], droppedCustomCssRules: number }
) {
  if (isReadOnly.value) return
  if (properties.title !== undefined) title.value = properties.title
  if (properties.description !== undefined) description.value = properties.description
  if (properties.audience !== undefined) audience.value = properties.audience
  if (properties.language !== undefined) language.value = properties.language
  if (properties.templateId !== undefined) setTemplateId(properties.templateId)
  if (properties.theme && canEditTheme.value) setTheme(properties.theme)
  const skipped = notes.ignored.length > 0 || notes.droppedCustomCssRules > 0
  toast.add({
    title: t('import.propertiesApplied'),
    description: skipped ? t('import.propertiesPartlyApplied') : undefined,
    icon: 'i-lucide-file-check-2',
    color: skipped ? 'neutral' : 'success'
  })
}

// Server-rendered PDF from the Playwright renderer, served by /api/docs/:id/pdf
// as a 302 to a presigned S3 URL. Unlike `exportPdf()` (browser print dialog +
// paged.js), the bytes are produced server-side, so the recipient needn't have
// the editor open.
//
// Opens a new tab with `?inline=1` (Content-Disposition inline, so the PDF
// viewer renders it). A synthetic anchor click is used instead of
// `window.open()`: Nuxt UI's dropdown defers `onSelect` past the user-gesture
// window and Chrome's popup blocker swallows `window.open()`. The same pattern
// `downloadFile()` uses for the markdown export.
function openServerPdf() {
  if (refuseDownload()) return
  const a = document.createElement('a')
  a.href = `/api/docs/${props.docId}/pdf?inline=1`
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// Hijack Cmd/Ctrl+P so File → Print runs our hidden-iframe PDF flow; the
// browser default would print the whole app chrome. Intercepted at document
// level with `capture: true` to win against any focused element (CodeMirror,
// slideovers, modals).
//
// Mac detection prefers `navigator.userAgentData.platform` and falls back to
// `navigator.platform` (browsers without userAgentData, e.g. Safari < 17).
const isMacPlatform = (): boolean => {
  const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
  if (uad?.platform) return /mac/i.test(uad.platform)
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

// `useEventListener` rather than `onKeyStroke`: capture phase is required and
// `onKeyStroke` doesn't expose `capture`.
useEventListener(document, 'keydown', (e: KeyboardEvent) => {
  const isPrint = (isMacPlatform() ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey
    && (e.key === 'p' || e.key === 'P')
  if (!isPrint) return
  e.preventDefault()
  exportPdf()
}, { capture: true })

// Image insert via the menu; same flow as EditorToolbar's image button, kept
// in one upload pipeline behind useImageUpload.

// Table size modal, opened from the menu's Insert → Table and the toolbar's
// Table button. A centered dialog fits "I want a table" better than a popover
// far from the menu trigger.
const tableModalOpen = ref(false)
function onTableModalSelect(payload: { rows: number, cols: number }) {
  if (!editorView.value || isReadOnly.value) {
    tableModalOpen.value = false
    return
  }
  insertTable(editorView.value, payload.rows, payload.cols)
  tableModalOpen.value = false
}
const { uploadAndInsert: uploadImageAndInsert, error: imageUploadError } = useImageUpload(props.docId)
watch(imageUploadError, (err) => {
  if (!err) return
  toast.add({
    title: err === 'login_required' ? t('auth.loginRequired') : t('image.uploadFailed'),
    description: err === 'login_required' ? t('image.loginToUpload') : err,
    color: 'error'
  })
})
const { open: openImagePicker, onChange: onMenuImagePicked } = useFileDialog({
  accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
  multiple: false,
  reset: true
})
onMenuImagePicked(async (files) => {
  const file = files?.[0]
  if (!file || !editorView.value) return
  await uploadImageAndInsert(file, editorView.value)
})

// Menu-driven file actions. New document hits the same endpoint as the
// landing-page "New" button and navigates straight into it.
// "Created by a markoto user, not by markoto · Report" on documents without
// an owner account (anonymous creations). Waits for the first sync, when the
// token endpoint has told us who owns the doc (no flash on owned docs).
const { legalSurfaces } = useInstanceConfig()
const showUserContentBar = computed(() =>
  legalSurfaces.value
  && synced.value
  && !forbidden.value
  && !notFound.value
  && !hasOwner.value
  && !docWorkspaceId.value
)
const reportContentLink = computed(() => {
  const url = import.meta.client ? `${globalThis.location.origin}/d/${props.docId}` : `/d/${props.docId}`
  return { path: '/legal/abuse', query: { url } }
})

// Anonymous visitors pass the same terms + bot-check gate as the new-document dialog (useAnonDocCreate).
const anonDoc = useAnonDocCreate()
async function newDocument() {
  try {
    const docId = await anonDoc.createDocument()
    navigateTo(`/d/${docId}`)
  } catch (e) {
    if (e instanceof AnonGateCancelled) return
    toast.add({ title: t('error.documentCreateFailed'), color: 'error' })
  }
}

// Dispatched on the local UndoManager, same as the keyboard shortcut, so menu and keyboard agree.
function undo() {
  undoManager.undo()
}
function redo() {
  undoManager.redo()
}

// Sharing → Password opens the share modal (no scroll to the password section).
function openShareAtPassword() {
  showShareModal.value = true
}

const viewMode = ref<'edit' | 'preview' | 'split'>('split')
// Matches Tailwind's sm: breakpoint (640px and up is not mobile)
const isMobile = useMediaQuery('(max-width: 639px)')

// Adjust view mode by readOnly state and screen size
watch(isReadOnly, (readOnly) => {
  if (readOnly) {
    viewMode.value = 'preview'
  } else if (viewMode.value === 'preview') {
    // Edit access restored (e.g. after password verification): switch to split
    viewMode.value = isMobile.value ? 'edit' : 'split'
  }
}, { immediate: true })

watchEffect(() => {
  if (isMobile.value && viewMode.value === 'split') {
    viewMode.value = 'edit'
  }
})

// One-shot toast on a sync auth failure so the user knows read-only isn't a
// permission problem but a sync-layer one (per-IP rate limit, sync container
// restarted with a different JWT secret, clock skew). The persistent banner in
// the template carries the explanation + reload action.
watch(syncAuthFailed, (failed) => {
  if (!failed) return
  toast.add({
    title: t('editor.syncAuthFailedTitle'),
    description: t('editor.syncAuthFailedDescription'),
    icon: 'i-lucide-shield-alert',
    color: 'error'
  })
})

// The sync server refused an update (too large / invalid document setting)
// and the provider stopped. Later edits stay local, so say so: one toast plus
// the persistent banner below.
const syncRejectionMessage = computed(() => {
  switch (syncRejection.value) {
    case 'update-too-large': return t('editor.syncRejected.updateTooLarge')
    case 'document-too-large': return t('editor.syncRejected.documentTooLarge')
    case 'invalid-meta': return t('editor.syncRejected.invalidMeta')
    case 'invalid-update': return t('editor.syncRejected.invalidUpdate')
    default: return null
  }
})
watch(syncRejectionMessage, (message) => {
  if (!message) return
  toast.add({
    title: t('editor.syncRejected.title'),
    description: message,
    icon: 'i-lucide-cloud-off',
    color: 'error'
  })
})

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

// Mobile dropdown: view mode, theme and auth actions in one place to reduce
// top-bar clutter. The color-mode read is deferred to onMounted:
// useColorMode() returns 'light' on SSR, so a top-level read mismatches on
// hydration for dark-mode users (see app/AGENTS.md "Common Vue conventions").
const colorMode = useColorMode()
const colorModeValue = ref<'light' | 'dark'>('light')
onMounted(() => {
  colorModeValue.value = colorMode.value === 'dark' ? 'dark' : 'light'
})
watch(() => colorMode.value, (v) => {
  colorModeValue.value = v === 'dark' ? 'dark' : 'light'
})
const { loggedIn, user: sessionUser } = useUserSession()
// Login entries only for providers this instance has configured.
const { primaryLoginPath } = useInstanceConfig()
const { loginOptions } = useLoginOptions()
// Logout clears localStorage/sessionStorage/IDB, broadcasts to other tabs and
// tears down awareness BEFORE the session goes, so collaborators see the
// leaving frame on a still-open WS. See `composables/useLogout.ts`.
const { logout: performAuthLogout } = useLogout()
function handleLogout() {
  return performAuthLogout({
    beforeClear: () => {
      try {
        awareness.setLocalStateField('user', null)
      } catch { /* awareness may already be torn down */ }
    }
  })
}

const mobileMenuItems = computed(() => {
  const viewModeGroup = [
    {
      label: t('editor.edit'),
      icon: 'i-lucide-code-2',
      checked: viewMode.value === 'edit',
      type: 'checkbox' as const,
      onSelect: () => { viewMode.value = 'edit' }
    },
    {
      label: t('editor.preview'),
      icon: 'i-lucide-eye',
      checked: viewMode.value === 'preview',
      type: 'checkbox' as const,
      onSelect: () => { viewMode.value = 'preview' }
    }
  ]

  const themeGroup = [
    {
      label: colorModeValue.value === 'dark' ? t('menu.lightMode') : t('menu.darkMode'),
      icon: colorModeValue.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
      onSelect: () => {
        colorMode.preference = colorModeValue.value === 'dark' ? 'light' : 'dark'
      }
    }
  ]

  const authGroup = loggedIn.value
    ? [
        {
          label: sessionUser.value?.name || t('menu.account'),
          icon: 'i-lucide-user',
          disabled: true
        },
        {
          label: t('auth.logout'),
          icon: 'i-lucide-log-out',
          onSelect: () => handleLogout()
        }
      ]
    : loginOptions.value.map(option => ({
        label: option.label,
        icon: option.icon,
        to: option.to,
        external: true
      }))

  // File actions (the desktop File menu's mobile counterpart). Move / Duplicate
  // gate on canManageDoc like the menu bar; Delete on the server's `canDelete`
  // (also true for the browser that created an anonymous doc).
  const fileGroup = [
    {
      label: t('menubar.file.new'),
      icon: 'i-lucide-file-plus',
      onSelect: () => newDocument()
    },
    {
      label: t('menubar.file.import'),
      icon: 'i-lucide-upload',
      onSelect: () => { showImportModal.value = true }
    },
    ...(noDownload.value
      ? []
      : [
          {
            label: t('menubar.file.export'),
            icon: 'i-lucide-file-down',
            onSelect: () => exportMarkdown()
          },
          {
            label: t('menubar.file.print'),
            icon: 'i-lucide-printer',
            onSelect: () => exportPdf()
          },
          {
            label: t('export.pdf'),
            icon: 'i-lucide-file-output',
            onSelect: () => openServerPdf()
          }
        ]),
    ...(canManageDoc.value
      ? [
          {
            label: t('menubar.file.duplicate'),
            icon: 'i-lucide-copy',
            onSelect: () => { showDuplicateModal.value = true }
          },
          {
            label: t('menubar.file.move'),
            icon: 'i-lucide-folder-input',
            onSelect: () => { showMoveModal.value = true }
          }
        ]
      : []),
    ...(canDelete.value
      ? [
          {
            label: t('menubar.file.delete'),
            icon: 'i-lucide-trash-2',
            onSelect: () => { showDeleteModal.value = true }
          }
        ]
      : [])
  ]

  // Help: the phone's stand-in for the desktop Help menu (shortcuts need a keyboard).
  const helpGroup = [
    {
      label: t('menubar.help.docs'),
      icon: 'i-lucide-book-open',
      onSelect: () => openDocs()
    },
    {
      label: t('menubar.help.tour'),
      icon: 'i-lucide-map',
      onSelect: () => editorTour.value?.start()
    }
  ]

  return [fileGroup, viewModeGroup, themeGroup, helpGroup, authGroup]
})

// Help → Documentation opens in a new tab so the document stays open.
function openDocs(): void {
  window.open('/docs', '_blank', 'noopener')
}

const showShortcuts = ref(false)

// First-run tour (EditorTour.vue): shown once per browser when the editor is
// ready to write in; Help → "Take the tour" re-opens it.
const editorTour = useTemplateRef<{ start: () => void }>('editorTour')
const tourReady = computed(() => synced.value && !isReadOnly.value && !requiresPassword.value && editorView.value !== null)

// Y.js text as a reactive string for the preview. Observes the Y.Doc 'update'
// event rather than ytext.observe: yCollab replaces the text binding in
// EditorPane's onMounted, while the doc-level event fires for every mutation.
const textContent = shallowRef('')
const updateContent = () => {
  textContent.value = ytext.toString()
}
ydoc.on('update', updateContent)
// Also update when sync completes (initial server content doesn't always fire 'update').
watch(synced, (isSynced) => {
  if (isSynced) updateContent()
})
// Persist word count, debounced to 10 s after the last content change.
const persistStats = useDebounceFn(() => {
  if (!isOwner.value || requiresPassword.value || !textContent.value) return
  $fetch(`/api/docs/${props.docId}/meta`, {
    method: 'PUT',
    body: {
      wordCount: wordCount.value,
      sizeBytes: new Blob([textContent.value]).size
    }
  }).catch(() => {})
}, 10000)

watch(textContent, () => {
  persistStats()
})
// Also persist once the initial sync completes.
watch(synced, (s) => {
  if (s) persistStats()
})

onUnmounted(() => {
  ydoc.off('update', updateContent)
})

const wordCount = computed(() => {
  if (!textContent.value.trim()) return 0
  return textContent.value.trim().split(/\s+/).length
})
const charCount = computed(() => textContent.value.length)

// `useFocus` handles focus only, so entering edit mode sets it and then
// selects the text on a tick.
const editingTitle = ref(false)
const titleInput = ref('')
const titleInputEl = ref<HTMLInputElement | null>(null)
const { focused: titleFocused } = useFocus(titleInputEl)

function startEditTitle() {
  titleInput.value = title.value
  editingTitle.value = true
  nextTick(() => {
    titleFocused.value = true
    titleInputEl.value?.select()
  })
}

async function saveTitle() {
  const newTitle = titleInput.value.trim()
  if (newTitle && newTitle !== title.value) {
    title.value = newTitle
    // Persist to the DB so the title appears in document lists.
    try {
      await $fetch(`/api/docs/${props.docId}/meta`, {
        method: 'PUT',
        body: { title: newTitle }
      })
    } catch {
      // Y.js still has the title; DB persistence is best-effort.
    }
  }
  editingTitle.value = false
}

// Tab title follows the live doc title so several open docs can be told apart.
// `useHead` with a getter is the SSR-safe idiom: Y.js syncs `title` after
// hydration. Falls back to "Untitled" while loading or when cleared.
useHead({
  title: () => title.value || t('editor.untitled')
})

const _statusColor = computed(() => {
  switch (status.value) {
    case 'connected': return 'success' as const
    case 'connecting': return 'warning' as const
    case 'disconnected': return 'error' as const
    default: return 'neutral' as const
  }
})

const _statusIcon = computed(() => {
  switch (status.value) {
    case 'connected': return 'i-lucide-wifi'
    case 'connecting': return 'i-lucide-loader'
    case 'disconnected': return 'i-lucide-wifi-off'
    default: return 'i-lucide-wifi-off'
  }
})
</script>

<template>
  <!-- Doc doesn't exist (token endpoint 404'd). Without this screen the empty
       token leaves the provider unable to connect and the user sees a
       misleading "disconnected / view only" editor. -->
  <div
    v-if="notFound"
    class="h-dvh flex items-center justify-center p-6 bg-[var(--ui-bg)]"
  >
    <div class="max-w-md w-full text-center space-y-4">
      <div class="mx-auto size-14 rounded-full bg-muted flex items-center justify-center">
        <UIcon
          name="i-lucide-file-question"
          class="size-7 text-muted"
        />
      </div>
      <h1 class="text-xl font-semibold">
        {{ t('access.notFoundTitle') }}
      </h1>
      <p class="text-sm text-muted">
        {{ t('access.notFoundDesc') }}
      </p>
      <div class="flex justify-center gap-2 pt-2">
        <UButton
          variant="soft"
          @click="navigateTo('/')"
        >
          {{ t('access.backHome') }}
        </UButton>
      </div>
    </div>
  </div>

  <!-- Private document opened by a non-owner. Short-circuits before any editor
       chrome: no token was fetched and there is no Y.Doc content. -->
  <div
    v-else-if="forbidden"
    class="h-dvh flex items-center justify-center p-6 bg-[var(--ui-bg)]"
  >
    <div class="max-w-md w-full text-center space-y-4">
      <div class="mx-auto size-14 rounded-full bg-amber-500/10 flex items-center justify-center">
        <UIcon
          name="i-lucide-lock-keyhole"
          class="size-7 text-amber-500"
        />
      </div>
      <h1 class="text-xl font-semibold">
        {{ shareExpired ? t('share.controls.expiredTitle') : t('access.privateTitle') }}
      </h1>
      <p class="text-sm text-muted">
        {{ shareExpired ? t('share.controls.expiredBody') : ssoLoginUrl ? t('sso.requiredBody') : loggedIn ? t('access.privateDescLoggedIn') : t('access.privateDescAnon') }}
      </p>
      <div class="flex justify-center gap-2 pt-2">
        <UButton
          variant="soft"
          @click="navigateTo('/')"
        >
          {{ t('access.backHome') }}
        </UButton>
        <UButton
          v-if="!loggedIn && primaryLoginPath"
          color="primary"
          @click="navigateTo(primaryLoginPath, { external: true })"
        >
          {{ t('auth.login') }}
        </UButton>
        <!-- The doc's workspace enforces single sign-on. -->
        <UButton
          v-if="ssoLoginUrl"
          color="neutral"
          icon="i-lucide-key-round"
          data-testid="doc-sso-sign-in"
          @click="navigateTo(ssoLoginUrl, { external: true })"
        >
          {{ t('sso.signIn') }}
        </UButton>
      </div>
    </div>
  </div>

  <!-- h-dvh, not h-screen: 100vh ignores the mobile address bar, so the shell
       overran the screen and the AI bar slid under the fixed MobileTabBar. -->
  <div
    v-else
    class="h-dvh flex flex-col"
  >
    <!-- Header: three-column flex so the view-mode group sits visually centered;
         left and right own equal flex space and align inward. -->
    <!-- `bg-muted` shares the gentler chrome field with the right sidebar and the
         preview surround; white cards and paper sheets pop against it. -->
    <header class="border-b border-default/60 bg-muted px-4 py-2 flex items-center gap-3 shrink-0">
      <div class="flex-1 min-w-0 flex items-center gap-3">
        <!-- Brand lockup (wordmark + seal), the same anchor as dashboard and
             workspace pages: always the leftmost item. -->
        <NuxtLink
          to="/"
          class="flex items-center shrink-0"
          aria-label="markoto home"
        >
          <CommonWordmark :size="18" />
        </NuxtLink>
        <!-- Managed instance: the customer's logo; the name only on wide screens (the title needs the room). -->
        <CommonInstanceBrand
          class="hidden md:inline-flex"
          :size="18"
          :show-name="false"
        />
        <USeparator
          orientation="vertical"
          class="h-5"
        />

        <div
          v-if="editingTitle"
          class="flex items-center gap-1"
        >
          <input
            ref="titleInputEl"
            v-model="titleInput"
            :aria-label="t('editor.titleInputAria')"
            data-testid="doc-title-input"
            class="bg-transparent border border-default rounded px-2 py-0.5 text-sm w-48 outline-none focus:border-primary"
            @keydown.enter="saveTitle"
            @keydown.escape="editingTitle = false"
            @blur="saveTitle"
          >
        </div>
        <!-- Fraunces serif at weight 400: the title reads as a published piece, not a filename. -->
        <button
          v-else
          data-testid="doc-title-button"
          class="font-serif text-[19px] font-normal tracking-tight leading-none text-default hover:text-muted transition-colors truncate min-w-0 max-w-[180px] sm:max-w-56 md:max-w-80"
          @click="startEditTitle"
        >
          {{ title }}
        </button>
        <!-- Team / Business plan of the doc's workspace: which plan this document's features and AI follow. -->
        <UBadge
          v-if="workspacePlan"
          size="xs"
          color="neutral"
          variant="outline"
          class="hidden sm:inline-flex shrink-0"
          data-testid="doc-plan-badge"
        >
          {{ workspacePlan === 'team' ? 'Team' : 'Business' }}
        </UBadge>

        <CollabPresenceBar
          :awareness="awareness"
          :doc-id="docId"
        />

        <!-- Only shown when something is wrong: `connecting` (reconnect
             attempt) or `disconnected` (lost WS). Connected is the default. -->
        <span
          v-if="status !== 'connected'"
          class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/70 bg-default font-mono text-[10.5px] tracking-[0.04em] text-muted lowercase"
          data-testid="connection-status"
          :data-status="status"
        >
          <span
            class="block size-1.5 rounded-full shrink-0"
            :class="{
              'bg-amber-500/80 dark:bg-amber-400/80 animate-pulse': status === 'connecting',
              'bg-rose-500/80 dark:bg-rose-400/80': status === 'disconnected'
            }"
            aria-hidden="true"
          />
          <span class="hidden sm:inline">{{ t(`status.${status}`) }}</span>
        </span>

        <!-- Calm chip like the status indicator; presence itself is shown by the colored avatar rings. -->
        <span
          v-if="userCount > 1"
          class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-default/70 bg-default font-mono text-[10.5px] tracking-[0.04em] text-muted"
        >
          <UIcon
            name="i-lucide-users"
            class="size-3"
          />
          {{ userCount }}
        </span>
      </div>

      <!-- View-mode toggle in its own zero-flex column so left and right groups balance around it. -->
      <div class="hidden sm:flex shrink-0 items-center justify-center">
        <UTooltip :text="t('editor.edit')">
          <UButton
            icon="i-lucide-code-2"
            size="xs"
            :color="viewMode === 'edit' ? 'primary' : 'neutral'"
            :variant="viewMode === 'edit' ? 'solid' : 'ghost'"
            :aria-label="t('editor.edit')"
            :aria-pressed="viewMode === 'edit'"
            data-testid="view-mode-edit"
            @click="viewMode = 'edit'"
          />
        </UTooltip>
        <UTooltip :text="t('editor.splitView')">
          <UButton
            icon="i-lucide-columns-2"
            size="xs"
            :color="viewMode === 'split' ? 'primary' : 'neutral'"
            :variant="viewMode === 'split' ? 'solid' : 'ghost'"
            :aria-label="t('editor.splitView')"
            :aria-pressed="viewMode === 'split'"
            data-testid="view-mode-split"
            @click="viewMode = 'split'"
          />
        </UTooltip>
        <UTooltip :text="t('editor.preview')">
          <UButton
            icon="i-lucide-eye"
            size="xs"
            :color="viewMode === 'preview' ? 'primary' : 'neutral'"
            :variant="viewMode === 'preview' ? 'solid' : 'ghost'"
            :aria-label="t('editor.preview')"
            :aria-pressed="viewMode === 'preview'"
            data-testid="view-mode-preview"
            @click="viewMode = 'preview'"
          />
        </UTooltip>
      </div>

      <!-- Lock shortcut, identity, mobile menu and the right-sidebar toggles.
           `flex-1 justify-end` mirrors the left group so the view-mode group
           stays centered. The sidebar toggles (Activity, Theme) sit at the
           edge after a separator, aligned with the column they open. -->
      <div class="flex-1 min-w-0 flex items-center gap-2 justify-end">
        <!-- Also under Sharing → Access; kept here because the open/closed lock doubles as an access indicator. -->
        <UTooltip :text="`${t('share.accessMode')}: ${t(accessLabelKey)}`">
          <UButton
            :icon="accessIcon"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="`${t('share.accessMode')}: ${t(accessLabelKey)}`"
            data-testid="access-lock-button"
            @click="showShareModal = true"
          />
        </UTooltip>

        <div class="hidden sm:flex items-center gap-2">
          <AuthUserMenu />
          <UColorModeButton />
        </div>

        <UDropdownMenu
          class="sm:hidden"
          :items="mobileMenuItems"
          :content="{ align: 'end' }"
        >
          <UButton
            icon="i-lucide-menu"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('common.menu')"
          />
        </UDropdownMenu>
      </div>
    </header>

    <template v-if="!requiresPassword">
      <!-- File / Edit / View / Insert / Format / Sharing / Help. The header icons
           duplicate the most common ones for speed; the menus aid findability.
           Hidden on mobile: formatting moves to the "Editor" tab, file/auth
           actions to the topbar dropdown. -->
      <div class="hidden sm:block">
        <EditorMenuBar
          :view="editorView"
          :doc-id="docId"
          :is-read-only="isReadOnly"
          :logged-in="loggedIn"
          :can-manage="canManageDoc"
          :can-delete="canDelete"
          :no-download="noDownload"
          :right-sidebar="rightSidebar"
          :has-knowledge-access="hasKnowledgeAccess"
          :view-mode="viewMode"
          :dictation-state="dictation.state.value"
          @open-import="showImportModal = true"
          @open-share="showShareModal = true"
          @open-share-password="openShareAtPassword"
          @export-markdown="exportMarkdown"
          @export-pdf="exportPdf"
          @open-server-pdf="openServerPdf"
          @new-document="newDocument"
          @duplicate-document="showDuplicateModal = true"
          @move-document="showMoveModal = true"
          @delete-document="showDeleteModal = true"
          @set-view-mode="(m) => viewMode = m"
          @toggle-sidebar="toggleSidebar"
          @undo="undo"
          @redo="redo"
          @open-image-picker="openImagePicker"
          @open-table-picker="tableModalOpen = true"
          @toggle-dictation="dictation.toggle()"
          @create-comment="triggerCreateComment"
          @open-docs="openDocs"
          @open-shortcuts="showShortcuts = true"
          @start-tour="editorTour?.start()"
        />
      </div>

      <!-- Sync handshake rejected. Distinct from ordinary read-only states
           (workspace viewer, password gate); explains why edit access vanished. -->
      <div
        v-if="syncAuthFailed"
        class="border-b border-error bg-error/10 text-error px-4 py-2 flex items-center gap-3 text-sm"
        role="alert"
      >
        <UIcon
          name="i-lucide-shield-alert"
          class="size-4 shrink-0"
        />
        <div class="flex-1 min-w-0">
          <span class="font-medium">{{ t('editor.syncAuthFailedTitle') }}</span>
          <span class="ml-2 text-xs opacity-80">{{ t('editor.syncAuthFailedDescription') }}</span>
        </div>
        <UButton
          size="xs"
          color="error"
          variant="solid"
          icon="i-lucide-rotate-ccw"
          @click="$router.go(0)"
        >
          {{ t('editor.syncAuthFailedReload') }}
        </UButton>
      </div>

      <!-- The server refused an update (too large, invalid document setting).
           Unlike the auth banner the editor stays editable, but nothing is
           saved until a reload. -->
      <div
        v-if="syncRejectionMessage"
        class="border-b border-error bg-error/10 text-error px-4 py-2 flex items-center gap-3 text-sm"
        role="alert"
        data-testid="sync-rejection-banner"
      >
        <UIcon
          name="i-lucide-cloud-off"
          class="size-4 shrink-0"
        />
        <div class="flex-1 min-w-0">
          <span class="font-medium">{{ t('editor.syncRejected.title') }}</span>
          <span class="ml-2 text-xs opacity-80">{{ syncRejectionMessage }}</span>
        </div>
        <UButton
          size="xs"
          color="error"
          variant="solid"
          icon="i-lucide-rotate-ccw"
          @click="$router.go(0)"
        >
          {{ t('editor.syncAuthFailedReload') }}
        </UButton>
      </div>

      <!-- Docs created without an account are written by anonymous visitors,
           not the operator. Links the report form (prefilled with this URL);
           only where legal surfaces exist, and not on owned or workspace docs. -->
      <div
        v-if="showUserContentBar"
        class="border-b border-default bg-muted px-4 py-1 flex items-center gap-2 font-mono text-[10.5px] tracking-wide text-muted shrink-0"
        data-testid="user-content-bar"
      >
        <UIcon
          name="i-lucide-info"
          class="size-3.5 shrink-0"
        />
        <span class="min-w-0 truncate">{{ t('userContent.notice') }}</span>
        <span aria-hidden="true">·</span>
        <NuxtLink
          :to="reportContentLink"
          class="underline shrink-0"
          data-testid="user-content-report"
        >
          {{ t('userContent.report') }}
        </NuxtLink>
      </div>

      <!-- Left: formatting actions, kept as an icon row (faster once learned)
                 even though the Format / Insert menus have them.
           Right: panel toggles (Activity, Theme), right-aligned above the
                  sidebar column they open. -->
      <div class="border-b border-default shrink-0 flex items-center justify-between">
        <!-- Hidden below `sm`; mobile reaches the same commands through the
             "Editor" tab (EditorCommandsPanel drawer). -->
        <div class="hidden sm:block flex-1 min-w-0">
          <EditorToolbar
            v-if="viewMode !== 'preview'"
            :view="editorView"
            :read-only="isReadOnly"
            :doc-id="docId"
            :dictation-state="dictation.state.value"
            @open-table-picker="tableModalOpen = true"
            @toggle-dictation="dictation.toggle()"
            @create-comment="triggerCreateComment"
          />
        </div>
        <!-- Mobile: the panel picker is the bottom MobileTabBar, outside this header. -->

        <!-- Desktop: 5-button strip; hidden on mobile, where it plus the title would overflow at 390px. -->
        <div class="hidden sm:flex items-center gap-0.5 px-2 py-1 shrink-0">
          <UTooltip :text="t('documentPanel.title')">
            <UButton
              icon="i-lucide-info"
              color="neutral"
              :variant="rightSidebar === 'document' ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="t('documentPanel.title')"
              :aria-pressed="rightSidebar === 'document'"
              data-testid="sidebar-tab-document"
              @click="toggleSidebar('document')"
            />
          </UTooltip>
          <UTooltip :text="t('comments.title')">
            <UButton
              icon="i-lucide-message-circle"
              color="neutral"
              :variant="rightSidebar === 'comments' ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="t('comments.title')"
              :aria-pressed="rightSidebar === 'comments'"
              data-testid="sidebar-tab-comments"
              @click="toggleSidebar('comments')"
            />
          </UTooltip>
          <UTooltip :text="t('activity.title')">
            <UButton
              icon="i-lucide-activity"
              color="neutral"
              :variant="rightSidebar === 'activity' ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="t('activity.title')"
              :aria-pressed="rightSidebar === 'activity'"
              data-testid="sidebar-tab-activity"
              @click="toggleSidebar('activity')"
            />
          </UTooltip>
          <UTooltip
            v-if="canEditTheme"
            :text="t('theme.title')"
          >
            <UButton
              icon="i-lucide-palette"
              color="neutral"
              :variant="rightSidebar === 'theme' ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="t('theme.title')"
              :aria-pressed="rightSidebar === 'theme'"
              data-testid="sidebar-tab-theme"
              @click="toggleSidebar('theme')"
            />
          </UTooltip>
          <UTooltip
            v-if="hasKnowledgeAccess"
            :text="t('knowledge.title')"
          >
            <UButton
              icon="i-lucide-library"
              color="neutral"
              :variant="rightSidebar === 'knowledge' ? 'soft' : 'ghost'"
              size="xs"
              :aria-label="t('knowledge.title')"
              :aria-pressed="rightSidebar === 'knowledge'"
              data-testid="sidebar-tab-knowledge"
              @click="toggleSidebar('knowledge')"
            />
          </UTooltip>
        </div>
      </div>

      <div
        v-if="isReadOnly"
        class="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-center text-sm text-amber-600 dark:text-amber-400"
      >
        <UIcon
          name="i-lucide-lock"
          class="size-3.5 mr-1 align-text-bottom"
        />
        View only
      </div>

      <!-- Flex siblings with `flex-1` / `min-w-0` share the width. Triple-split
           (editor + preview + sidebar) starts at `xl` (1280px); below that the
           sidebar replaces the preview. `relative` anchors the floating AI
           prompt bar to the bottom of this zone, not the page. -->
      <main class="flex-1 flex min-h-0 relative">
        <!-- ImageDropZone handles drag-drop and paste uploads -->
        <EditorImageDropZone
          v-if="viewMode !== 'preview'"
          :doc-id="docId"
          :editor-view="editorView"
          :read-only="isReadOnly"
          :class="[
            // Flex member — shares remaining width with preview / sidebar.
            // `min-w-0` lets the pane shrink past its intrinsic content width.
            'flex-1 min-w-0',
            // Right border only when something visible sits to its right.
            (viewMode === 'split' || rightSidebar) ? 'border-r border-default' : ''
            // Never hide the pane on mobile: the bottom sheet covers only the lower
            // part of the viewport and the editor must stay visible above it.
          ]"
          class="h-full"
        >
          <EditorPane
            ref="editorPaneRef"
            :ytext="ytext"
            :awareness="awareness"
            :undo-manager="undoManager"
            :read-only="isReadOnly"
            :comment-ranges="commentRanges"
            :on-comment-click="onCommentClickInEditor"
          />
        </EditorImageDropZone>

        <!-- Hidden by CSS (not v-if) while the sidebar is open below xl, so it
             reappears on resize past xl without re-mounting the markdown-it pipeline. -->
        <div
          v-if="viewMode !== 'edit'"
          :class="[
            'flex-1 min-w-0 h-full',
            rightSidebar ? 'hidden xl:block' : ''
          ]"
        >
          <PreviewPane
            v-model:page-count="pageCount"
            :source="textContent"
            :title="title"
            :language="language"
            :theme="renderTheme"
            :doc-id="docId"
            :get-doc-jwt="getDocJwt"
            :brand-fonts="brandFonts"
            :zoom-control="!isMobile"
            @print-shortcut="exportPdf"
          />
        </div>

        <!-- One slot for all sidebar panels, mutually exclusive via `toggleSidebar`.
             - edit mode:           fixed sidebar (w-80), full-width on xs
             - split/preview, <xl:  right half (flex-1); preview hidden
             - split/preview, xl+:  fixed 320px sidebar (triple-split) -->
        <RightPanelHost
          :open="!!rightSidebar"
          :view-mode="viewMode"
          @close="closeSidebar"
        >
          <DocumentEditorPanel
            v-if="rightSidebar === 'document'"
            :description="description"
            :audience="audience"
            :language="language"
            :can-edit="!isReadOnly"
            @update:description="(v: string) => description = v"
            @update:audience="(v: string) => audience = v"
            @update:language="(v: string) => language = v"
            @close="closeSidebar"
          />
          <CommentsPanel
            v-else-if="rightSidebar === 'comments'"
            ref="commentsPanelRef"
            :ytext="ytext"
            :awareness="awareness"
            :view="editorView"
            :doc-id="docId"
            :doc-workspace-id="docWorkspaceId"
            :read-only="isReadOnly"
            @focus="onCommentPanelFocus"
            @close="closeSidebar"
          />
          <div
            v-else-if="rightSidebar === 'activity'"
            class="h-full flex flex-col bg-muted"
          >
            <!-- Same Fraunces title register as the Comments panel. -->
            <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
              <div class="flex items-center gap-2">
                <UIcon
                  name="i-lucide-activity"
                  class="size-4 text-muted"
                />
                <h3 class="font-serif text-base font-normal tracking-tight">
                  {{ t('activity.title') }}
                </h3>
              </div>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                class="mk-panel-close"
                data-testid="panel-close"
                :aria-label="t('common.close')"
                @click="closeSidebar"
              />
            </div>
            <!-- Owns padding + scrolling; `bg-muted` is on the panel root. -->
            <div class="flex-1 overflow-y-auto p-2 min-h-0">
              <CollabActivityFeed
                :doc-id="docId"
                :ydoc="ydoc"
                :read-only="isReadOnly"
              />
            </div>
          </div>
          <DocumentThemeEditorPanel
            v-else-if="rightSidebar === 'theme'"
            :theme="theme as DocTheme"
            :doc-id="docId"
            :can-edit="canEditTheme"
            :custom-css-allowed="customCssAllowed"
            :workspace-id="docWorkspaceRole ? docWorkspaceId : null"
            :brand-locked="brandLockedTheme !== null"
            :can-manage-brand="docWorkspaceRole === 'admin'"
            @update:theme="setTheme"
            @reset="resetTheme"
            @close="closeSidebar"
          />
          <!-- Same upload/list/delete surface as the workspace overview, scoped to
               this doc's workspace. Rendered only with hasKnowledgeAccess, so
               workspaceId / docWorkspaceRole are non-null here. -->
          <div
            v-else-if="rightSidebar === 'knowledge' && docWorkspaceId && docWorkspaceRole"
            class="h-full flex flex-col bg-muted"
          >
            <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
              <div class="flex items-center gap-2">
                <UIcon
                  name="i-lucide-library"
                  class="size-4 text-muted"
                />
                <h3 class="font-serif text-base font-normal tracking-tight">
                  {{ t('knowledge.title') }}
                </h3>
              </div>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                class="mk-panel-close"
                data-testid="panel-close"
                :aria-label="t('common.close')"
                @click="closeSidebar"
              />
            </div>
            <div class="flex-1 overflow-y-auto p-3 min-h-0">
              <WorkspaceKnowledgePanel
                :workspace-id="docWorkspaceId"
                :my-role="docWorkspaceRole"
                :my-user-id="sessionUser?.id ?? null"
                compact
              />
            </div>
          </div>
          <!-- Mobile only (the desktop toolbar covers `>=sm`). Actions run through
               the editorCommands.ts helpers and emit `done` to close the sheet and
               refocus the editor; table-size and image picker handoffs are forwarded. -->
          <EditorCommandsPanel
            v-else-if="rightSidebar === 'editor'"
            :view="editorView"
            :can-comment="!isReadOnly"
            @done="closeSidebar"
            @close="closeSidebar"
            @open-table-picker="tableModalOpen = true"
            @open-image-picker="openImagePicker"
            @open-import="showImportModal = true"
            @open-server-pdf="openServerPdf"
            @export-markdown="exportMarkdown"
          />
        </RightPanelHost>

        <!-- Overlay at the bottom of the content area, spanning editor + preview +
             sidebar. Hidden in preview-only mode and when read-only. It positions
             itself absolutely, so this `<main>` must stay `relative`. -->
        <AIPromptBar
          v-if="!isReadOnly && viewMode !== 'preview'"
          :ai="ai"
          :workspace-id="docWorkspaceId"
        />

        <!-- The only panel navigation below `sm`. Tabs: Document, Comments,
             Activity, Theme, Knowledge, Editor (commands drawer), Mic (toggles
             dictation directly). Hidden when read-only or in preview mode. -->
        <MobileTabBar
          v-if="!isReadOnly && viewMode !== 'preview'"
          :active-panel="rightSidebar"
          :can-edit-theme="canEditTheme"
          :has-knowledge-access="hasKnowledgeAccess"
          :dictation-state="dictation.state.value"
          @select="onMobileTabSelect"
          @toggle-dictation="dictation.toggle()"
        />

        <!-- Mobile view-mode toggle. The desktop group lives in the topbar
             (`hidden sm:flex`); on mobile it floats top-right of the content
             area, since the bottom holds the AIResponsePanel + AIPromptBar +
             MobileTabBar stack. Offers only edit and preview (no useful 50/50
             at 390px). Hidden on `>=sm`. -->
        <div
          class="sm:hidden absolute top-3 right-3 z-30 inline-flex items-center gap-0.5 rounded-full border border-default bg-default shadow-md p-0.5"
          data-testid="mobile-viewmode-bar"
        >
          <button
            type="button"
            class="inline-flex items-center justify-center size-8 rounded-full transition-colors"
            :class="viewMode === 'edit' ? 'bg-muted text-default' : 'text-muted hover:text-default'"
            :aria-label="t('editor.edit')"
            :aria-pressed="viewMode === 'edit'"
            @click="viewMode = 'edit'"
          >
            <UIcon
              name="i-lucide-pen"
              class="size-4"
            />
          </button>
          <button
            type="button"
            class="inline-flex items-center justify-center size-8 rounded-full transition-colors"
            :class="viewMode === 'preview' ? 'bg-muted text-default' : 'text-muted hover:text-default'"
            :aria-label="t('editor.preview')"
            :aria-pressed="viewMode === 'preview'"
            @click="viewMode = 'preview'"
          >
            <UIcon
              name="i-lucide-eye"
              class="size-4"
            />
          </button>
          <!-- Preview zoom (fit width / all pages / fixed steps); pinch on the preview zooms too. -->
          <template v-if="viewMode === 'preview'">
            <span
              class="mx-0.5 h-4 w-px bg-[var(--ui-border)]"
              aria-hidden="true"
            />
            <PreviewZoomControl compact />
          </template>
        </div>
      </main>

      <!-- Mono micro-meta (10.5px, lowercase, 0.04em tracking, middot separators), like a colophon strip. -->
      <footer class="border-t border-default/60 bg-muted px-4 py-1.5 flex items-center justify-between font-mono text-[10.5px] tracking-[0.04em] text-muted shrink-0">
        <div class="flex items-center gap-3">
          <span data-testid="word-count">{{ wordCount }} <span class="opacity-70">words</span></span>
          <span
            class="opacity-50"
            aria-hidden="true"
          >·</span>
          <span
            v-if="viewMode !== 'edit' && pageCount > 0"
            data-testid="page-count"
          >{{ pageCount }} <span class="opacity-70">{{ pageCount === 1 ? 'page' : 'pages' }}</span></span>
          <span
            v-if="viewMode !== 'edit' && pageCount > 0"
            class="opacity-50"
            aria-hidden="true"
          >·</span>
          <span data-testid="char-count">{{ charCount }} <span class="opacity-70">chars</span></span>
        </div>
        <div
          class="flex items-center gap-3"
          data-testid="sync-status"
        >
          <span
            v-if="synced"
            class="inline-flex items-center gap-1.5"
          >
            <span
              class="block size-1.5 rounded-full bg-green-600 dark:bg-green-500"
              aria-hidden="true"
            />
            {{ t('status.synced') }}
          </span>
          <span
            v-if="isReadOnly"
            class="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400"
          >
            <UIcon
              name="i-lucide-lock"
              class="size-3"
            />
            read only
          </span>
        </div>
      </footer>
    </template>

    <div
      v-else
      class="flex-1 flex items-center justify-center"
    >
      <div class="text-center text-muted">
        <UIcon
          name="i-lucide-lock"
          class="size-12 mb-4"
        />
        <p class="text-sm">
          {{ t('share.passwordRequiredDesc') }}
        </p>
      </div>
    </div>
    <DocumentImportModal
      v-model:open="showImportModal"
      :ytext="ytext"
      :read-only="isReadOnly"
      :doc-id="docId"
      @apply-properties="applyImportedProperties"
    />

    <EditorKeyboardShortcutsModal v-model:open="showShortcuts" />
    <EditorTour
      ref="editorTour"
      :ready="tourReady"
      :is-mobile="isMobile"
    />

    <SharingShareModal
      v-model:open="showShareModal"
      :doc-id="docId"
      :doc-title="title"
      :is-owner="isOwner"
      :current-access-mode="accessMode"
      :can-manage="canManageDoc"
      :can-share-with-guests="!!docWorkspaceId && (docWorkspaceRole === 'admin' || docWorkspaceRole === 'editor')"
      @updated="(mode: string) => { setAccessMode(mode); showShareModal = false }"
    />

    <!-- Creates a new doc owned by the current user (same content, theme and images) and redirects to it. -->
    <DocumentDuplicateDocModal
      v-model:open="showDuplicateModal"
      :doc-id="docId"
      :source-title="title"
      @duplicated="(newDocId) => navigateTo(`/d/${newDocId}`)"
    />

    <!-- Reassigns the doc's workspace; owner or workspace admin only. -->
    <DocumentMoveWorkspaceModal
      v-model:open="showMoveModal"
      :doc-id="docId"
      :doc-title="title"
      :current-workspace-id="docWorkspaceId"
    />

    <!-- Owner-only entry from File → Delete. -->
    <DocumentDeleteConfirmModal
      v-model:open="showDeleteModal"
      :doc-id="docId"
      :title="title"
      @deleting="setDeletingHere(true)"
      @failed="setDeletingHere(false)"
      @deleted="navigateTo('/')"
    />

    <SharingPasswordModal
      v-model:open="passwordModalOpen"
      :doc-id="docId"
      @verified="onPasswordVerified"
      @cancel="navigateTo('/')"
    />

    <!-- From the menu bar's Insert → Table or the toolbar's Table button. -->
    <UModal
      v-model:open="tableModalOpen"
      :title="t('table.title')"
      :description="t('table.description')"
      :ui="{ content: 'max-w-fit' }"
    >
      <template #body>
        <TableSizePicker @select="onTableModalSelect" />
      </template>
    </UModal>

    <!-- Floating "Comment" pill on text selection; click runs the toolbar's create-comment handler. -->
    <CommentsCommentSelectionPopup
      v-if="!requiresPassword"
      :view="editorView"
      :disabled="isReadOnly"
      @trigger="triggerCreateComment"
    />
  </div>
</template>
