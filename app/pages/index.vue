<script setup lang="ts">
import type { WorkspaceListItem } from '~/components/workspace/WorkspaceList.vue'

const { t } = useI18n()
const router = useRouter()
const { loggedIn } = useUserSession()
const { billing, workspaceCapReached } = useBilling()

const toast = useToast()
const { showError, showContextualError } = useErrorHandler()

// Tooltip shown when the user tries to hover the disabled
// "New workspace" button. Concrete numbers so the limit is visible;
// upgrade path advertised on the second line.
const workspaceCapTooltip = computed(() => {
  const b = billing.value
  if (!b) return ''
  return t('workspace.capReached', {
    used: b.ownedWorkspaces,
    limit: b.workspacesOwnedLimit,
    plan: b.plan.charAt(0).toUpperCase() + b.plan.slice(1)
  })
})

function onCapReachedClick() {
  router.push('/pricing')
}

// OAuth account-merge flash. The auth handler redirects to
// `/?linked=github` or `/?linked=google` when a second-provider
// sign-in landed on an existing row (matched by verified email) and
// we added the new provider id to it. Surface a one-time toast
// explaining what happened, then strip the query param so a reload
// doesn't re-show the toast.
onMounted(() => {
  const route = useRoute()
  const linked = route.query.linked
  if (typeof linked === 'string' && (linked === 'github' || linked === 'google')) {
    const providerName = linked === 'github' ? 'GitHub' : 'Google'
    toast.add({
      title: t('auth.linkedTitle'),
      description: t('auth.linkedDescription', { provider: providerName }),
      icon: 'i-lucide-link',
      color: 'success'
    })
    // Strip the query param so a reload doesn't re-fire the toast.
    router.replace({ query: { ...route.query, linked: undefined } })
  }
})

// New-doc dialog. Replaces the old one-click POST so the user gets a
// chance to seed title/description/audience/language/theme up-front —
// the AI then has authoritative context from the very first prompt.
// Skip path inside the dialog ("Just give me a blank doc") preserves
// the legacy zero-config flow for muscle memory.
const showNewDocDialog = ref(false)
function createDocument() {
  showNewDocDialog.value = true
}
function onDocCreated(docId: string) {
  router.push(`/d/${docId}`)
}

// Fetch user's documents if logged in
interface DocumentListItem {
  docId: string
  title: string
  description: string
  language: string
  accessMode: 'private' | 'open-edit' | 'open-view' | 'password-protected'
  wordCount: number
  lastActive: string | number | Date
  sizeBytes: number
  workspaceId: string | null
  isOwner: boolean | number
}

const myDocs = ref<DocumentListItem[]>([])
const myWorkspaces = ref<WorkspaceListItem[]>([])
const loadingDocs = ref(false)
const loadingWorkspaces = ref(false)

async function loadDocs() {
  if (!loggedIn.value) {
    myDocs.value = []
    return
  }
  loadingDocs.value = true
  try {
    myDocs.value = await $fetch<DocumentListItem[]>('/api/user/documents')
  } catch (e) {
    myDocs.value = []
    showContextualError(e, 'error.generic')
  } finally {
    loadingDocs.value = false
  }
}

async function loadWorkspaces() {
  if (!loggedIn.value) {
    myWorkspaces.value = []
    return
  }
  loadingWorkspaces.value = true
  try {
    myWorkspaces.value = await $fetch<WorkspaceListItem[]>('/api/user/workspaces')
  } catch (e) {
    myWorkspaces.value = []
    showContextualError(e, 'error.generic')
  } finally {
    loadingWorkspaces.value = false
  }
}

watch(loggedIn, () => {
  loadDocs()
  loadWorkspaces()
}, { immediate: true })

// Delete modal state
const deleteTarget = ref<DocumentListItem | null>(null)
const showDeleteConfirm = ref(false)

function openDeleteConfirm(doc: DocumentListItem) {
  deleteTarget.value = doc
  showDeleteConfirm.value = true
}

function onDocDeleted() {
  if (!deleteTarget.value) return
  // Optimistically remove from list (the server call already succeeded at this point)
  myDocs.value = myDocs.value.filter(d => d.docId !== deleteTarget.value!.docId)
  deleteTarget.value = null
}

// Duplicate / Move modals. Dashboard shows personal + owned-in-workspace
// docs; every entry here is owned by the caller, so canManage is true
// for all of them (no per-row gating needed).
const duplicateTarget = ref<DocumentListItem | null>(null)
const showDuplicateModal = ref(false)
const moveTarget = ref<DocumentListItem | null>(null)
const showMoveModal = ref(false)

function openDuplicate(doc: DocumentListItem) {
  duplicateTarget.value = doc
  showDuplicateModal.value = true
}
function openMove(doc: DocumentListItem) {
  moveTarget.value = doc
  showMoveModal.value = true
}
function onDocDuplicated(newDocId: string) {
  router.push(`/d/${newDocId}`)
}
function onDocMoved(newWorkspaceId: string | null) {
  // The "Recent Documents" list on the dashboard shows all owned docs
  // regardless of workspace, so a move doesn't need to drop the row.
  // If the target is a workspace, the user probably wants to see the
  // doc in the workspace view — but re-fetching here is enough for
  // updated metadata. Noop for now; visible state already accurate.
  void newWorkspaceId
  moveTarget.value = null
}

// Workspace create
const showCreateWorkspace = ref(false)

function onWorkspaceCreated(workspaceId: string) {
  router.push(`/w/${workspaceId}`)
}

function formatDate(value: string | number | Date) {
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header -->
    <header class="border-b border-default px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-file-text"
          class="text-primary size-6"
        />
        <span class="text-lg font-semibold">{{ t('app.name') }}</span>
      </div>
      <div class="flex items-center gap-2">
        <AuthUserMenu />
        <UColorModeButton />
      </div>
    </header>

    <!-- Hero -->
    <main class="flex-1 flex flex-col items-center px-6 py-12">
      <div class="max-w-2xl text-center space-y-6">
        <h1 class="text-4xl md:text-5xl font-bold tracking-tight">
          {{ t('landing.hero') }}
        </h1>
        <p class="text-lg text-muted">
          {{ t('landing.subtitle') }}
        </p>
        <div class="flex flex-col sm:flex-row gap-3 justify-center">
          <UButton
            size="xl"
            icon="i-lucide-plus"
            @click="createDocument"
          >
            {{ t('landing.newDocument') }}
          </UButton>
          <!-- At-cap pattern: stays visible, muted styling + tooltip +
               click routes to /pricing. We never hide the button (user
               should still see the feature exists) and never silently
               no-op on click (we redirect them toward upgrading). The
               native `disabled` attribute is NOT used because that
               would also suppress the click — we want the click to
               navigate, not do nothing. -->
          <UButton
            v-if="loggedIn"
            size="xl"
            color="neutral"
            :variant="workspaceCapReached ? 'ghost' : 'subtle'"
            :icon="workspaceCapReached ? 'i-lucide-lock' : 'i-lucide-folder-plus'"
            :class="workspaceCapReached ? 'opacity-60' : ''"
            :title="workspaceCapReached ? workspaceCapTooltip : undefined"
            @click="workspaceCapReached ? onCapReachedClick() : (showCreateWorkspace = true)"
          >
            {{ workspaceCapReached ? t('workspace.capReachedShort') : t('workspace.newWorkspace') }}
          </UButton>
        </div>
      </div>

      <!-- My workspaces -->
      <div
        v-if="loggedIn && (myWorkspaces.length > 0 || loadingWorkspaces)"
        class="mt-12 w-full max-w-4xl"
      >
        <h2 class="text-lg font-semibold mb-4">
          {{ t('workspace.sectionTitle') }}
        </h2>
        <WorkspaceList
          :workspaces="myWorkspaces"
          :loading="loadingWorkspaces"
        />
      </div>

      <!-- Recent documents -->
      <div
        v-if="loggedIn && myDocs.length > 0"
        class="mt-12 w-full max-w-2xl"
      >
        <h2 class="text-lg font-semibold mb-4">
          {{ t('landing.recentDocuments') }}
        </h2>
        <div class="space-y-2">
          <div
            v-for="doc in myDocs"
            :key="doc.docId"
            class="group flex items-center gap-3 p-3 rounded-lg border border-default hover:bg-muted/50 transition-colors"
          >
            <NuxtLink
              :to="`/d/${doc.docId}`"
              class="flex items-center gap-3 min-w-0 flex-1"
            >
              <UIcon
                name="i-lucide-file-text"
                class="size-5 text-muted shrink-0"
              />
              <div class="min-w-0">
                <p class="text-sm font-medium truncate">{{ doc.title }}</p>
                <!-- Description as a subtitle when set. Highest-info
                     field for picking which doc to open; collapses
                     entirely when empty so legacy/blank docs don't
                     show "—" placeholders. -->
                <p
                  v-if="doc.description"
                  class="text-xs text-toned truncate"
                >
                  {{ doc.description }}
                </p>
                <p class="text-xs text-muted">{{ formatDate(doc.lastActive) }}</p>
              </div>
            </NuxtLink>
            <div class="flex items-center gap-2 shrink-0">
              <UBadge
                v-if="doc.accessMode !== 'open-edit'"
                size="xs"
                color="neutral"
                variant="subtle"
              >
                {{
                  doc.accessMode === 'private' ? 'Private'
                  : doc.accessMode === 'open-view' ? 'View only'
                    : 'Protected'
                }}
              </UBadge>
              <span class="text-xs text-muted">{{ doc.wordCount || 0 }} words</span>
              <UDropdownMenu
                v-if="doc.isOwner"
                :items="[[
                  {
                    label: t('common.duplicate'),
                    icon: 'i-lucide-copy',
                    onSelect: () => openDuplicate(doc)
                  },
                  {
                    label: t('common.move'),
                    icon: 'i-lucide-folder-input',
                    onSelect: () => openMove(doc)
                  },
                  { type: 'separator' },
                  {
                    label: t('common.delete'),
                    icon: 'i-lucide-trash-2',
                    color: 'error',
                    onSelect: () => openDeleteConfirm(doc)
                  }
                ]]"
              >
                <UButton
                  icon="i-lucide-more-vertical"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="opacity-60 group-hover:opacity-100 transition-opacity"
                />
              </UDropdownMenu>
            </div>
          </div>
        </div>
      </div>

      <!-- New-document dialog. Standalone (no workspace) on the home
           page; the workspace page passes its own workspaceId in. -->
      <DocumentNewDocumentDialog
        v-model:open="showNewDocDialog"
        :workspace-id="null"
        @created="onDocCreated"
      />

      <!-- Delete confirmation (shared across all doc rows) -->
      <DocumentDeleteConfirmModal
        v-if="deleteTarget"
        v-model:open="showDeleteConfirm"
        :doc-id="deleteTarget.docId"
        :title="deleteTarget.title"
        @deleted="onDocDeleted"
      />

      <DocumentDuplicateDocModal
        v-if="duplicateTarget"
        v-model:open="showDuplicateModal"
        :doc-id="duplicateTarget.docId"
        :source-title="duplicateTarget.title"
        @duplicated="onDocDuplicated"
      />

      <DocumentMoveWorkspaceModal
        v-if="moveTarget"
        v-model:open="showMoveModal"
        :doc-id="moveTarget.docId"
        :doc-title="moveTarget.title"
        :current-workspace-id="moveTarget.workspaceId"
        @moved="onDocMoved"
      />

      <!-- Create workspace modal -->
      <WorkspaceFormModal
        v-model:open="showCreateWorkspace"
        @created="onWorkspaceCreated"
      />

      <div
        v-if="loggedIn && loadingDocs && myDocs.length === 0"
        class="mt-12"
      >
        <UIcon
          name="i-lucide-loader"
          class="size-5 animate-spin text-muted"
        />
      </div>

      <!-- Features -->
      <div class="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl w-full">
        <div class="text-center space-y-2">
          <UIcon
            name="i-lucide-users"
            class="text-primary size-8 mx-auto"
          />
          <h3 class="font-semibold">
            Real-time Collaboration
          </h3>
          <p class="text-sm text-muted">
            Edit together with live cursors and presence indicators
          </p>
        </div>
        <div class="text-center space-y-2">
          <UIcon
            name="i-lucide-sparkles"
            class="text-primary size-8 mx-auto"
          />
          <h3 class="font-semibold">
            AI Writing Assistant
          </h3>
          <p class="text-sm text-muted">
            Get intelligent suggestions and completions as you write
          </p>
        </div>
        <div class="text-center space-y-2">
          <UIcon
            name="i-lucide-shield-check"
            class="text-primary size-8 mx-auto"
          />
          <h3 class="font-semibold">
            Flexible Sharing
          </h3>
          <p class="text-sm text-muted">
            Public, view-only, or password-protected documents
          </p>
        </div>
      </div>
    </main>

    <!-- Footer -->
    <footer class="border-t border-default px-6 py-4 text-center text-sm text-muted">
      YPad — Collaborative Markdown Editor
    </footer>
  </div>
</template>
