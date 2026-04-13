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
  accessMode,
  undoManager,
  title,
  onPasswordVerified,
  setAccessMode
} = useDocument(props.docId)

// AI collaborator — joins doc as its own Y.js client; edits broadcast naturally.
const ai = useAI(computed(() => props.docId), awareness)

const toast = useToast()

// Share modal state
const showShareModal = ref(false)
// Import modal state
const showImportModal = ref(false)
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
// Activity sidebar state
const showActivity = ref(false)
// Export state
const exporting = ref(false)

async function exportDocument(format: 'pdf' | 'docx' | 'html') {
  exporting.value = true
  try {
    // Read content fresh from ytext — shallowRef may be stale after HMR
    const content = ytext.toString()
    const response = await fetch(`/api/export/${props.docId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: content, format })
    })
    if (!response.ok) throw new Error(`Export failed: ${response.status}`)
    const blob = await response.blob()
    downloadFile(blob, `${title.value}.${format}`)
  } catch (e: any) {
    console.error('Export failed:', e)
  } finally {
    exporting.value = false
  }
}

function exportMarkdown() {
  downloadMarkdown(textContent.value, title.value)
}

function exportHtml() {
  // Use the preview rendered HTML
  const previewEl = document.querySelector('.preview-content')
  if (previewEl) {
    downloadHtml(previewEl.innerHTML, title.value)
  } else {
    // Fallback: export raw markdown as HTML via Pandoc
    exportDocument('html')
  }
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

// Track editor view for toolbar
const editorPaneRef = ref<{ view: EditorView | null } | null>(null)
const editorView = computed(() => editorPaneRef.value?.view ?? null)

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
  <div class="h-screen flex flex-col">
    <!-- Editor Header -->
    <header class="border-b border-default px-4 py-2 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-3 min-w-0">
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

      <div class="flex items-center gap-2 shrink-0">
        <!-- View mode toggle: desktop only -->
        <div class="hidden sm:flex">
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

        <!-- Share button: always visible (primary collaboration action) -->
        <UTooltip :text="t('share.share')">
          <UButton
            icon="i-lucide-share-2"
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
      <!-- Toolbar row: formatting left, document actions right.
           On narrow viewports the formatting toolbar wraps to multiple rows
           while action buttons stay top-right. -->
      <div class="flex items-start justify-between border-b border-default shrink-0 gap-2">
        <div class="flex-1 min-w-0">
          <EditorToolbar
            v-if="viewMode !== 'preview'"
            :view="editorView"
            :read-only="isReadOnly"
            :doc-id="docId"
          />
        </div>

        <div class="flex items-center gap-0.5 px-2 py-1 shrink-0">
          <!-- Import button -->
          <UTooltip v-if="!isReadOnly" :text="t('import.title')">
            <UButton
              icon="i-lucide-file-up"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="showImportModal = true"
            />
          </UTooltip>

          <!-- Export dropdown -->
          <UDropdownMenu
            :items="[
              {
                label: t('export.markdown'),
                icon: 'i-lucide-file-text',
                onSelect: exportMarkdown
              },
              {
                label: t('export.html'),
                icon: 'i-lucide-code',
                onSelect: exportHtml
              },
              {
                label: t('export.pdf'),
                icon: 'i-lucide-file-output',
                onSelect: () => exportDocument('pdf')
              },
              {
                label: t('export.docx'),
                icon: 'i-lucide-file-output',
                onSelect: () => exportDocument('docx')
              }
            ]"
          >
            <UTooltip :text="t('export.title')">
              <UButton
                icon="i-lucide-download"
                color="neutral"
                variant="ghost"
                size="xs"
                :loading="exporting"
              />
            </UTooltip>
          </UDropdownMenu>

          <USeparator orientation="vertical" class="h-5 mx-1" />

          <!-- Activity button -->
          <UTooltip :text="t('activity.title')">
            <UButton
              icon="i-lucide-activity"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="showActivity = !showActivity"
            />
          </UTooltip>
        </div>
      </div>

      <!-- AI prompt bar (hidden in preview-only or when read-only) -->
      <AIPromptBar
        v-if="!isReadOnly && viewMode !== 'preview'"
        :ai="ai"
      />

      <!-- Read-only banner -->
      <div v-if="isReadOnly" class="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-center text-sm text-amber-600 dark:text-amber-400">
        <UIcon name="i-lucide-lock" class="size-3.5 mr-1 align-text-bottom" />
        View only
      </div>

      <!-- Main editor area -->
      <main class="flex-1 flex min-h-0">
        <!-- Editor (wrapped in ImageDropZone for drag-drop + paste uploads) -->
        <EditorImageDropZone
          v-if="viewMode !== 'preview'"
          :doc-id="docId"
          :editor-view="editorView"
          :read-only="isReadOnly"
          :class="[
            viewMode === 'split' ? 'w-1/2 border-r border-default' : 'w-full',
            showActivity ? 'hidden sm:block' : ''
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

        <!-- Preview -->
        <div
          v-if="viewMode !== 'edit' && !showActivity"
          :class="viewMode === 'split' ? 'w-1/2' : 'w-full'"
          class="h-full"
        >
          <PreviewPane :source="textContent" />
        </div>

        <!-- Activity sidebar — fills the right pane in split/preview; sidebar-width in edit mode -->
        <div
          v-if="showActivity"
          :class="[
            viewMode === 'split' ? 'w-full sm:w-1/2' : '',
            viewMode === 'preview' ? 'w-full' : '',
            viewMode === 'edit' ? 'w-full sm:w-80' : ''
          ]"
          class="border-l border-default h-full overflow-y-auto shrink-0"
        >
          <div class="p-3 border-b border-default flex items-center justify-between">
            <h3 class="text-sm font-semibold">{{ t('activity.title') }}</h3>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="showActivity = false"
            />
          </div>
          <div class="p-2">
            <CollabActivityFeed :doc-id="docId" :ydoc="ydoc" />
          </div>
        </div>
      </main>

      <!-- Status bar -->
      <footer class="border-t border-default px-4 py-1 flex items-center justify-between text-xs text-muted shrink-0">
        <div class="flex items-center gap-4">
          <span>{{ wordCount }} words</span>
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
