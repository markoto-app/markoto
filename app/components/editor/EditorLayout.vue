<script setup lang="ts">
import type { EditorView } from '@codemirror/view'

const props = defineProps<{
  docId: string
}>()

const { t } = useI18n()

const {
  ydoc,
  ytext,
  awareness,
  provider,
  status,
  synced,
  userCount,
  isReadOnly,
  isOwner,
  isDeleted,
  requiresPassword,
  forbidden,
  accessMode,
  undoManager,
  title,
  theme,
  canEditTheme,
  setTheme,
  resetTheme,
  onPasswordVerified,
  setAccessMode
} = useDocument(props.docId)

// AI collaborator — joins doc as its own Y.js client; edits broadcast naturally.
const ai = useAI(computed(() => props.docId), awareness)

const toast = useToast()

// Share modal state
const showShareModal = ref(false)
// Delete-confirmation modal — its own modal under File → Delete (and
// available to Sharing as a backup shortcut). Was previously buried in
// the share modal's danger-zone block; lives standalone now.
const showDeleteModal = ref(false)
// Import modal state
const showImportModal = ref(false)
// Right-sidebar slot — mutually exclusive between activity and theme.
// Both panels share the same column so the layout shift is predictable
// regardless of which one is open.
const rightSidebar = ref<'activity' | 'theme' | null>(null)
function toggleSidebar(panel: 'activity' | 'theme') {
  rightSidebar.value = rightSidebar.value === panel ? null : panel
}
function closeSidebar() {
  rightSidebar.value = null
}
// Password modal: open when requiresPassword is true, closable only via verify/cancel
const passwordModalOpen = ref(false)
watch(requiresPassword, (val) => {
  passwordModalOpen.value = val
}, { immediate: true })

// If the doc was deleted remotely (e.g. by the owner from another session),
// show a toast and redirect to the landing page.
watch(isDeleted, (deleted) => {
  if (!deleted) return
  toast.add({
    title: t('delete.remoteTitle'),
    description: t('delete.remoteDesc'),
    icon: 'i-lucide-trash-2',
    color: 'warning'
  })
  navigateTo('/')
})
// PDF export state — drives the dropdown loader spinner.
const exporting = ref(false)
// Page count from the paged.js preview, surfaced in the status bar.
const pageCount = ref(0)

// Access-mode header button — closed lock when the doc is restricted (private
// or password-protected), open lock when anyone with the link gets in (view or
// edit). Keeping the icon binary avoids collisions with nearby icons (the eye
// is already used by the preview/split toggle) and matches the mental model
// users have for "is this locked or not". The tooltip carries the precise
// label so view-only vs open-edit is still distinguishable on hover.
const ACCESS_LABELS: Record<string, string> = {
  private: 'share.private',
  'open-edit': 'share.openEdit',
  'open-view': 'share.openView',
  'password-protected': 'share.passwordProtected'
}
const LOCKED_MODES = new Set(['private', 'password-protected'])
const accessIcon = computed(() => LOCKED_MODES.has(accessMode.value) ? 'i-lucide-lock' : 'i-lucide-lock-open')
const accessLabelKey = computed(() => ACCESS_LABELS[accessMode.value] ?? 'share.openEdit')

async function exportPdf() {
  exporting.value = true
  try {
    // Read content fresh from ytext — shallowRef may be stale after HMR.
    await printDocumentAsPdf({
      source: ytext.toString(),
      theme: theme.value,
      title: title.value
    })
  } catch (e: any) {
    console.error('PDF export failed:', e)
    toast.add({
      title: 'PDF export failed',
      description: e?.message ?? 'Unknown error',
      color: 'error'
    })
  } finally {
    exporting.value = false
  }
}

function exportMarkdown() {
  downloadMarkdown(textContent.value, title.value)
}

// Hijack Cmd/Ctrl+P so the shortcut shown in File → Print actually runs
// our hidden-iframe PDF flow instead of the browser's default print
// (which would render the entire app chrome — toolbars, sidebars, the
// AI bar — alongside the doc and look terrible). We intercept at the
// document level with `capture: true` so we win against any element
// that may be focused (CodeMirror, slideovers, modals).
useEventListener(document, 'keydown', (e: KeyboardEvent) => {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  const isPrint = (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey
    && (e.key === 'p' || e.key === 'P')
  if (!isPrint) return
  e.preventDefault()
  exportPdf()
}, { capture: true })

// Hidden file input for image insert via menu (mirrors the same flow
// EditorToolbar uses for its image button — keeps the upload pipeline
// in one place behind useImageUpload).
const menuImageInput = ref<HTMLInputElement | null>(null)
const { uploadAndInsert: uploadImageAndInsert, error: imageUploadError } = useImageUpload(props.docId)
watch(imageUploadError, (err) => {
  if (!err) return
  toast.add({
    title: err === 'login_required' ? t('auth.loginRequired') : t('image.uploadFailed'),
    description: err === 'login_required' ? t('image.loginToUpload') : err,
    color: 'error'
  })
})
function openImagePicker() {
  menuImageInput.value?.click()
}
async function onMenuImageSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !editorView.value) return
  await uploadImageAndInsert(file, editorView.value)
  input.value = ''
}

// Menu-driven file actions. New-document hits the same endpoint as the
// landing-page "New" button; we navigate immediately so the user lands
// in their fresh doc.
async function newDocument() {
  try {
    const data = await $fetch<{ docId: string }>('/api/docs', { method: 'POST' })
    navigateTo(`/d/${data.docId}`)
  } catch {
    toast.add({ title: 'Could not create document', color: 'error' })
  }
}

// Undo / redo dispatched on the local UndoManager — same instance the
// keyboard shortcut hits, so menu and keyboard stay in lockstep.
function undo() { undoManager.undo() }
function redo() { undoManager.redo() }

// Sharing → Password opens the existing share modal — auto-scrolling to
// the right section is a polish item; for now we just open it and the
// user sees the password section in the panel.
function openShareAtPassword() {
  showShareModal.value = true
}

// View mode: 'edit' | 'preview' | 'split'
const viewMode = ref<'edit' | 'preview' | 'split'>('split')
// Matches Tailwind's sm: breakpoint (640px and up = not-mobile)
const isMobile = useMediaQuery('(max-width: 639px)')

// Adjust view mode based on readOnly state and screen size
watch(isReadOnly, (readOnly) => {
  if (readOnly) {
    viewMode.value = 'preview'
  } else if (viewMode.value === 'preview') {
    // Restored edit access (e.g. after password verification) — switch to split
    viewMode.value = isMobile.value ? 'edit' : 'split'
  }
}, { immediate: true })

watchEffect(() => {
  if (isMobile.value && viewMode.value === 'split') {
    viewMode.value = 'edit'
  }
})

// Track editor view for toolbar.
// Gnarly type dance: Vue's `ref<{ view: EditorView | null }>` recursively
// applies `UnwrapRef` to the wrapped object, which turns the inner
// `EditorView` into a `Readonly<EditorView>`. TS treats classes with private
// fields nominally — `Readonly<EditorView>` fails the assignability check to
// `EditorView` (missing `dispatchTransactions`, `_root`, `plugins`, …).
// The cast inside the computed re-asserts the real runtime type; the
// shallowRef on the child side keeps the instance unproxied so this is safe.
const editorPaneRef = ref<{ view: EditorView | null } | null>(null)
const editorView = computed<EditorView | null>(
  () => (editorPaneRef.value?.view ?? null) as EditorView | null
)

// Mobile dropdown menu — consolidates view mode, theme, and auth actions
// to reduce top-bar clutter on small screens.
const colorMode = useColorMode()
const { loggedIn, user: sessionUser, clear: clearSession } = useUserSession()

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
      label: colorMode.value === 'dark' ? t('menu.lightMode') : t('menu.darkMode'),
      icon: colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
      onSelect: () => {
        colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
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
          onSelect: () => clearSession()
        }
      ]
    : [
        {
          label: t('auth.loginGithub'),
          icon: 'i-simple-icons-github',
          to: '/auth/github',
          external: true
        },
        {
          label: t('auth.loginGoogle'),
          icon: 'i-simple-icons-google',
          to: '/auth/google',
          external: true
        }
      ]

  return [viewModeGroup, themeGroup, authGroup]
})

// Track Y.js text content as a reactive string for preview.
// We observe on the Y.Doc 'update' event rather than ytext.observe because
// yCollab replaces the text binding during EditorPane's onMounted, and
// the doc-level event is guaranteed to fire for all mutations.
const textContent = shallowRef('')
const updateContent = () => {
  textContent.value = ytext.toString()
}
ydoc.on('update', updateContent)
// Also update when sync completes (initial content from server doesn't always fire 'update')
watch(synced, (isSynced) => {
  if (isSynced) updateContent()
})
// Persist word count to DB — debounced, fires 10s after last content change
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

watch(textContent, () => { persistStats() })
// Also persist once initial sync completes
watch(synced, (s) => { if (s) persistStats() })

onUnmounted(() => {
  ydoc.off('update', updateContent)
})

// Word/char counts derived from polled textContent
const wordCount = computed(() => {
  if (!textContent.value.trim()) return 0
  return textContent.value.trim().split(/\s+/).length
})
const charCount = computed(() => textContent.value.length)

// Editable title
const editingTitle = ref(false)
const titleInput = ref('')
const titleInputEl = ref<HTMLInputElement | null>(null)

function startEditTitle() {
  titleInput.value = title.value
  editingTitle.value = true
  nextTick(() => {
    titleInputEl.value?.focus()
    titleInputEl.value?.select()
  })
}

async function saveTitle() {
  const newTitle = titleInput.value.trim()
  if (newTitle && newTitle !== title.value) {
    title.value = newTitle
    // Persist title to database so it appears in document lists
    try {
      await $fetch(`/api/docs/${props.docId}/meta`, {
        method: 'PUT',
        body: { title: newTitle }
      })
    } catch {
      // Y.js sync still has the title — DB persistence is best-effort
    }
  }
  editingTitle.value = false
}

const statusColor = computed(() => {
  switch (status.value) {
    case 'connected': return 'success' as const
    case 'connecting': return 'warning' as const
    case 'disconnected': return 'error' as const
  }
})

const statusIcon = computed(() => {
  switch (status.value) {
    case 'connected': return 'i-lucide-wifi'
    case 'connecting': return 'i-lucide-loader'
    case 'disconnected': return 'i-lucide-wifi-off'
  }
})
</script>

<template>
  <!-- Private document, accessed by someone who isn't the owner. Short-circuit
       before rendering any editor chrome — we never fetched a token, there's
       no Y.Doc content, and the user can't interact with any toolbar actions. -->
  <div
    v-if="forbidden"
    class="h-screen flex items-center justify-center p-6 bg-[var(--ui-bg)]"
  >
    <div class="max-w-md w-full text-center space-y-4">
      <div class="mx-auto size-14 rounded-full bg-amber-500/10 flex items-center justify-center">
        <UIcon name="i-lucide-lock-keyhole" class="size-7 text-amber-500" />
      </div>
      <h1 class="text-xl font-semibold">{{ t('access.privateTitle') }}</h1>
      <p class="text-sm text-muted">
        {{ loggedIn ? t('access.privateDescLoggedIn') : t('access.privateDescAnon') }}
      </p>
      <div class="flex justify-center gap-2 pt-2">
        <UButton variant="soft" @click="navigateTo('/')">
          {{ t('access.backHome') }}
        </UButton>
        <UButton v-if="!loggedIn" color="primary" @click="navigateTo('/auth/github', { external: true })">
          {{ t('auth.login') }}
        </UButton>
      </div>
    </div>
  </div>

  <div v-else class="h-screen flex flex-col">
    <!-- Editor Header — three-column flex so the view-mode group sits
         visually centered in the bar (the page is the doc, view mode
         picks how you look at it; centering matches the right-pane
         framing). Left/right sides own equal flex space and align their
         contents inward toward the center group. -->
    <header class="border-b border-default px-4 py-2 flex items-center gap-3 shrink-0">
      <div class="flex-1 min-w-0 flex items-center gap-3">
        <NuxtLink to="/" class="flex items-center gap-1.5 text-muted hover:text-default transition-colors shrink-0">
          <UIcon name="i-lucide-file-text" class="text-primary size-5" />
          <span class="font-semibold text-sm hidden sm:inline">{{ t('app.name') }}</span>
        </NuxtLink>
        <USeparator orientation="vertical" class="h-5" />

        <!-- Editable title -->
        <div v-if="editingTitle" class="flex items-center gap-1">
          <input
            ref="titleInputEl"
            v-model="titleInput"
            class="bg-transparent border border-default rounded px-2 py-0.5 text-sm w-48 outline-none focus:border-primary"
            @keydown.enter="saveTitle"
            @keydown.escape="editingTitle = false"
            @blur="saveTitle"
          >
        </div>
        <button
          v-else
          class="text-sm text-muted hover:text-default transition-colors truncate min-w-0 max-w-[180px] sm:max-w-56 md:max-w-80"
          @click="startEditTitle"
        >
          {{ title }}
        </button>

        <!-- Collaborators next to title -->
        <CollabPresenceBar :awareness="awareness" />

        <!-- Connection status: icon-only on mobile to save space -->
        <UBadge :color="statusColor" variant="subtle" size="sm">
          <UIcon :name="statusIcon" class="size-3 sm:mr-1" />
          <span class="hidden sm:inline">{{ t(`status.${status}`) }}</span>
        </UBadge>

        <!-- User count -->
        <UBadge v-if="userCount > 1" color="info" variant="subtle" size="sm">
          <UIcon name="i-lucide-users" class="size-3 mr-1" />
          {{ userCount }}
        </UBadge>
      </div>

      <!-- Center group — view-mode toggle. Sits in its own zero-flex
           column so the left/right groups balance around it; the buttons
           themselves are tightly packed (no `gap` here). -->
      <div class="hidden sm:flex shrink-0 items-center justify-center">
        <UTooltip :text="t('editor.edit')">
          <UButton
            icon="i-lucide-code-2"
            size="xs"
            :color="viewMode === 'edit' ? 'primary' : 'neutral'"
            :variant="viewMode === 'edit' ? 'solid' : 'ghost'"
            @click="viewMode = 'edit'"
          />
        </UTooltip>
        <UTooltip :text="t('editor.splitView')">
          <UButton
            icon="i-lucide-columns-2"
            size="xs"
            :color="viewMode === 'split' ? 'primary' : 'neutral'"
            :variant="viewMode === 'split' ? 'solid' : 'ghost'"
            @click="viewMode = 'split'"
          />
        </UTooltip>
        <UTooltip :text="t('editor.preview')">
          <UButton
            icon="i-lucide-eye"
            size="xs"
            :color="viewMode === 'preview' ? 'primary' : 'neutral'"
            :variant="viewMode === 'preview' ? 'solid' : 'ghost'"
            @click="viewMode = 'preview'"
          />
        </UTooltip>
      </div>

      <!-- Right group — lock shortcut, identity, mobile menu, and the
           right-sidebar toggles. `flex-1 justify-end` mirrors the left
           group so the center view-mode group lands optically
           dead-center regardless of the left group's width.

           The sidebar toggles (Activity, Theme) sit at the very edge,
           after a separator, so they're spatially aligned with the
           sidebar column that opens directly below them. The lock /
           identity / theme controls stay closer to the center to keep
           the visual mapping "panel toggles → panel".  -->
      <div class="flex-1 min-w-0 flex items-center gap-2 justify-end">
        <!-- Access-mode shortcut. Also under Sharing → Access; kept in
             the header because the icon doubles as a status indicator
             (open vs closed lock = at-a-glance access tier). -->
        <UTooltip :text="`${t('share.accessMode')}: ${t(accessLabelKey)}`">
          <UButton
            :icon="accessIcon"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="showShareModal = true"
          />
        </UTooltip>

        <!-- Desktop: user menu + color mode inline -->
        <div class="hidden sm:flex items-center gap-2">
          <AuthUserMenu />
          <UColorModeButton />
        </div>

        <!-- Mobile: everything secondary behind a single "more" menu -->
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
          />
        </UDropdownMenu>

      </div>
    </header>

    <!-- Everything below the header is hidden until password is verified -->
    <template v-if="!requiresPassword">
      <!-- Top-level menu bar — File / Edit / View / Insert / Format /
           Sharing / Help. Discoverable home for everything that's not
           high-frequency editing. Header icons above are quick
           shortcuts for the most common ones (view-mode, sidebars,
           access lock); the menus duplicate them for findability. -->
      <EditorMenuBar
        :view="editorView"
        :doc-id="docId"
        :is-read-only="isReadOnly"
        :logged-in="loggedIn"
        :right-sidebar="rightSidebar"
        :view-mode="viewMode"
        @open-import="showImportModal = true"
        @open-share="showShareModal = true"
        @open-share-password="openShareAtPassword"
        @export-markdown="exportMarkdown"
        @export-pdf="exportPdf"
        @new-document="newDocument"
        @delete-document="showDeleteModal = true"
        @set-view-mode="(m) => viewMode = m"
        @toggle-sidebar="toggleSidebar"
        @undo="undo"
        @redo="redo"
        @open-image-picker="openImagePicker"
      />

      <!-- Toolbar row.
           Left:  formatting actions (bold / italic / headings / list / …).
                  High-frequency editing — kept as a visible icon row
                  even though the same actions live under Format / Insert
                  menus, because icons are faster once learned.
           Right: panel toggles (Activity, Theme). Sit on the same row
                  as the formatting buttons so they share the toolbar's
                  visual weight, and right-aligned so they're directly
                  above the right-sidebar column they open. -->
      <div class="border-b border-default shrink-0 flex items-center justify-between">
        <div class="flex-1 min-w-0">
          <EditorToolbar
            v-if="viewMode !== 'preview'"
            :view="editorView"
            :read-only="isReadOnly"
            :doc-id="docId"
          />
        </div>
        <div class="flex items-center gap-0.5 px-2 py-1 shrink-0">
          <UTooltip :text="t('activity.title')">
            <UButton
              icon="i-lucide-activity"
              color="neutral"
              :variant="rightSidebar === 'activity' ? 'soft' : 'ghost'"
              size="xs"
              @click="toggleSidebar('activity')"
            />
          </UTooltip>
          <UTooltip v-if="canEditTheme" :text="t('theme.title')">
            <UButton
              icon="i-lucide-palette"
              color="neutral"
              :variant="rightSidebar === 'theme' ? 'soft' : 'ghost'"
              size="xs"
              @click="toggleSidebar('theme')"
            />
          </UTooltip>
        </div>
      </div>

      <!-- Hidden file input owned by the menu's "Insert → Image" path. -->
      <input
        ref="menuImageInput"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        class="hidden"
        @change="onMenuImageSelected"
      >

      <!-- Read-only banner -->
      <div v-if="isReadOnly" class="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-center text-sm text-amber-600 dark:text-amber-400">
        <UIcon name="i-lucide-lock" class="size-3.5 mr-1 align-text-bottom" />
        View only
      </div>

      <!-- Main editor area.
           Layout uses flex siblings with `flex-1`/`min-w-0` so each pane
           grows into the remaining space. Triple-split (editor + preview +
           activity sidebar) kicks in at `xl` (1280px+) — below that, the
           activity replaces the preview to keep each pane legible.
           `relative` so the floating AI prompt bar (absolute-positioned
           inside this container) anchors to the bottom of the
           editor + preview + sidebar zone, not the page. -->
      <main class="flex-1 flex min-h-0 relative">
        <!-- Editor (wrapped in ImageDropZone for drag-drop + paste uploads) -->
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
            (viewMode === 'split' || rightSidebar) ? 'border-r border-default' : '',
            // On xs, when the right sidebar is open it covers the whole
            // viewport — hide the editor so it doesn't compete for layout.
            rightSidebar ? 'hidden sm:block' : ''
          ]"
          class="h-full"
        >
          <EditorPane
            ref="editorPaneRef"
            :ytext="ytext"
            :awareness="awareness"
            :undo-manager="undoManager"
            :read-only="isReadOnly"
          />
        </EditorImageDropZone>

        <!-- Preview.
             Always rendered when not in edit mode. Hidden by CSS (not v-if)
             when the right sidebar is open AND viewport is below xl — that way
             the preview re-appears instantly on resize past xl without
             re-mounting the markdown-it pipeline. -->
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
            :theme="theme"
          />
        </div>

        <!-- Right sidebar — single slot shared between Activity and Theme.
             Only one shows at a time; selection is mutually exclusive via
             `toggleSidebar`. Sizing matches the prior activity layout:
             - edit mode:           fixed sidebar (w-80), full-width on xs
             - split/preview, <xl:  takes the right half (flex-1); preview
                                    is hidden at that breakpoint
             - split/preview, xl+:  fixed 320px sidebar → triple-split -->
        <aside
          v-if="rightSidebar"
          :class="[
            viewMode === 'edit'
              ? 'w-full sm:w-80 sm:shrink-0'
              : 'flex-1 min-w-0 xl:flex-none xl:w-80 xl:shrink-0'
          ]"
          class="border-l border-default h-full overflow-hidden"
        >
          <div v-if="rightSidebar === 'activity'" class="h-full flex flex-col">
            <div class="p-3 border-b border-default flex items-center justify-between shrink-0">
              <div class="flex items-center gap-1.5">
                <UIcon name="i-lucide-activity" class="size-4 text-muted" />
                <h3 class="text-sm font-semibold">{{ t('activity.title') }}</h3>
              </div>
              <UButton
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                size="xs"
                @click="closeSidebar"
              />
            </div>
            <div class="flex-1 overflow-y-auto p-2 min-h-0">
              <CollabActivityFeed :doc-id="docId" :ydoc="ydoc" />
            </div>
          </div>
          <DocumentThemeEditorPanel
            v-else-if="rightSidebar === 'theme'"
            :theme="theme"
            :can-edit="canEditTheme"
            @update:theme="setTheme"
            @reset="resetTheme"
            @close="closeSidebar"
          />
        </aside>

        <!-- Floating AI prompt bar — overlay at the bottom of the
             content area so it spans the full editor + preview + sidebar
             zone. Hidden in preview-only mode (no editing happens) and
             when the doc is read-only (no edits accepted). The component
             positions itself absolutely; we just need this `<main>` to
             be `relative` (set above). -->
        <AIPromptBar
          v-if="!isReadOnly && viewMode !== 'preview'"
          :ai="ai"
        />
      </main>

      <!-- Status bar -->
      <footer class="border-t border-default px-4 py-1 flex items-center justify-between text-xs text-muted shrink-0">
        <div class="flex items-center gap-4">
          <span>{{ wordCount }} words</span>
          <span v-if="viewMode !== 'edit' && pageCount > 0">{{ pageCount }} {{ pageCount === 1 ? 'page' : 'pages' }}</span>
          <span>{{ charCount }} chars</span>
        </div>
        <div class="flex items-center gap-4">
          <span v-if="synced">
            <UIcon name="i-lucide-check-circle" class="size-3 mr-0.5 text-green-500 align-text-bottom" />
            {{ t('status.synced') }}
          </span>
          <span v-if="isReadOnly" class="text-amber-500">
            <UIcon name="i-lucide-lock" class="size-3 mr-0.5 align-text-bottom" />
            Read only
          </span>
        </div>
      </footer>
    </template>

    <!-- Password gate: show a clean prompt, no content behind it -->
    <div v-else class="flex-1 flex items-center justify-center">
      <div class="text-center text-muted">
        <UIcon name="i-lucide-lock" class="size-12 mb-4" />
        <p class="text-sm">{{ t('share.passwordRequiredDesc') }}</p>
      </div>
    </div>
    <!-- Import modal -->
    <DocumentImportModal
      v-model:open="showImportModal"
      :ytext="ytext"
      :read-only="isReadOnly"
    />

    <!-- Share modal -->
    <SharingShareModal
      v-model:open="showShareModal"
      :doc-id="docId"
      :doc-title="title"
      :is-owner="isOwner"
      :current-access-mode="accessMode"
      @updated="(mode: string) => { setAccessMode(mode); showShareModal = false }"
    />

    <!-- Delete confirmation — owner-only entry from File → Delete. -->
    <DocumentDeleteConfirmModal
      v-model:open="showDeleteModal"
      :doc-id="docId"
      :title="title"
      @deleted="navigateTo('/')"
    />

    <!-- Password gate -->
    <SharingPasswordModal
      v-model:open="passwordModalOpen"
      :doc-id="docId"
      @verified="onPasswordVerified"
      @cancel="navigateTo('/')"
    />

    <!-- AI selection popup — floats near the editor's current selection -->
    <AISelectionPopup
      v-if="!isReadOnly && !requiresPassword"
      :view="editorView"
      :ytext="ytext"
      :on-rewrite="(params) => ai.rewrite(params)"
    />
  </div>
</template>
