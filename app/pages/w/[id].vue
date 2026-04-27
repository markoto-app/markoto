<script setup lang="ts">
import type { WorkspaceDoc } from '~/components/workspace/WorkspaceDocTable.vue'
import type { WorkspaceMember } from '~/components/workspace/WorkspaceMemberAvatars.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { showError } = useErrorHandler()
const { loggedIn, user } = useUserSession()

const workspaceId = computed(() => route.params.id as string)

interface WorkspaceDetail {
  workspace: {
    workspaceId: string
    name: string
    description: string | null
    createdAt: string
    myRole: 'admin' | 'editor' | 'viewer'
    ownerId: number
    aiEnabled: boolean
    billingOwnerId: number | null
  }
  documents: WorkspaceDoc[]
  members: WorkspaceMember[]
}

const data = ref<WorkspaceDetail | null>(null)
const loading = ref(true)
const notFound = ref(false)
const forbidden = ref(false)

async function loadWorkspace() {
  loading.value = true
  notFound.value = false
  forbidden.value = false
  try {
    data.value = await $fetch<WorkspaceDetail>(`/api/workspaces/${workspaceId.value}`)
  } catch (e: any) {
    if (e?.statusCode === 404) notFound.value = true
    else if (e?.statusCode === 403 || e?.statusCode === 401) forbidden.value = true
    else showError('workspace.notFound', e)
  } finally {
    loading.value = false
  }
}

watch([workspaceId, loggedIn], loadWorkspace, { immediate: true })

const myRole = computed(() => data.value?.workspace.myRole ?? null)
const isAdmin = computed(() => myRole.value === 'admin')
const canCreateDoc = computed(() => myRole.value === 'admin' || myRole.value === 'editor')
const myUserId = computed(() => (user.value as any)?.id as number | undefined)

// Tabs split the workspace into three concerns. Default is Documents
// since that's what most visits are about. Nuxt UI v4's UTabs needs
// `value` on each item for v-model binding; `slot` picks the template.
const activeTab = ref<'documents' | 'knowledge' | 'ai'>('documents')
const tabItems = computed(() => [
  { label: t('workspace.tabs.documents'), icon: 'i-lucide-file-text', slot: 'documents' as const, value: 'documents' },
  { label: t('workspace.tabs.knowledge'), icon: 'i-lucide-library', slot: 'knowledge' as const, value: 'knowledge' },
  { label: t('workspace.tabs.ai'), icon: 'i-lucide-sparkles', slot: 'ai' as const, value: 'ai' }
])

// Same dialog flow as the home page; just pass our workspaceId so the
// new doc files into this workspace from the start.
const showNewDocDialog = ref(false)
function createDocument() {
  showNewDocDialog.value = true
}
function onDocCreated(docId: string) {
  router.push(`/d/${docId}`)
}

// Modals
const editOpen = ref(false)
const deleteOpen = ref(false)
const membersOpen = ref(false)
const deleteTargetDoc = ref<WorkspaceDoc | null>(null)
const showDocDeleteConfirm = ref(false)

// Duplicate / Move per-row targets. Using a single ref per action rather
// than a single "active doc" ref because the modals are independent and
// the user could (in theory) cancel one while the other is open.
const duplicateTargetDoc = ref<WorkspaceDoc | null>(null)
const showDuplicateModal = ref(false)
const moveTargetDoc = ref<WorkspaceDoc | null>(null)
const showMoveModal = ref(false)

function openDocDelete(doc: WorkspaceDoc) {
  deleteTargetDoc.value = doc
  showDocDeleteConfirm.value = true
}

function openDocDuplicate(doc: WorkspaceDoc) {
  duplicateTargetDoc.value = doc
  showDuplicateModal.value = true
}

function openDocMove(doc: WorkspaceDoc) {
  moveTargetDoc.value = doc
  showMoveModal.value = true
}

function onDocDeleted() {
  if (!deleteTargetDoc.value || !data.value) return
  data.value.documents = data.value.documents.filter(d => d.docId !== deleteTargetDoc.value!.docId)
  deleteTargetDoc.value = null
}

function onDocDuplicated(newDocId: string) {
  // Send the user into their fresh copy — matches the "file → duplicate"
  // flow in desktop apps, and the workspace view will re-hydrate on the
  // next visit. If the duplicate stayed in this workspace, reloading
  // here would surface it in the list too, but we'd rather the user
  // start editing immediately.
  router.push(`/d/${newDocId}`)
}

function onDocMoved(newWorkspaceId: string | null) {
  // Doc left this workspace (target is different): drop it from the
  // current list. Same-workspace no-op is impossible here because the
  // row's modal doesn't allow picking the current workspace's option
  // server-side it's a no-op anyway.
  if (!moveTargetDoc.value || !data.value) return
  if (newWorkspaceId !== workspaceId.value) {
    data.value.documents = data.value.documents.filter(
      d => d.docId !== moveTargetDoc.value!.docId
    )
  }
  moveTargetDoc.value = null
}

function onWorkspaceUpdated(payload: { name: string, description: string | null }) {
  if (!data.value) return
  data.value.workspace.name = payload.name
  data.value.workspace.description = payload.description
}

function onWorkspaceDeleted() {
  router.replace('/')
}

function onMembersUpdated(members: WorkspaceMember[]) {
  if (!data.value) return
  data.value.members = members
}

function onLeftWorkspace() {
  toast.add({
    title: t('workspace.members.leftToast'),
    icon: 'i-lucide-log-out',
    color: 'success'
  })
  router.replace('/')
}

// Admin vs non-admin see different workspace-level actions. Computed so the
// dropdown content swaps based on role without two separate templates.
const workspaceMenuItems = computed(() => {
  if (!data.value) return []
  const items: any[] = [
    {
      label: t('workspace.members.manageTitle'),
      icon: 'i-lucide-users',
      onSelect: () => { membersOpen.value = true }
    }
  ]
  if (isAdmin.value) {
    items.push({
      label: t('workspace.edit'),
      icon: 'i-lucide-pencil',
      onSelect: () => { editOpen.value = true }
    })
    items.push({
      label: t('workspace.delete'),
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => { deleteOpen.value = true }
    })
  } else {
    items.push({
      label: t('workspace.members.leave'),
      icon: 'i-lucide-log-out',
      color: 'error',
      onSelect: () => leaveWorkspace()
    })
  }
  return [items]
})

async function leaveWorkspace() {
  if (!data.value || myUserId.value == null) return
  try {
    await $fetch(`/api/workspaces/${data.value.workspace.workspaceId}/members/${myUserId.value}`, { method: 'DELETE' })
    onLeftWorkspace()
  } catch (e: any) {
    toast.add({
      title: t('workspace.members.leaveFailed'),
      description: e?.data?.message || e?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-default px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-3 min-w-0">
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-arrow-left"
          size="sm"
          to="/"
        >
          {{ t('workspace.backToHome') }}
        </UButton>
        <div class="flex items-center gap-2 min-w-0">
          <UIcon
            name="i-lucide-folder"
            class="text-primary size-5 shrink-0"
          />
          <span class="text-base font-semibold truncate">
            {{ data?.workspace.name || t('app.name') }}
          </span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <AuthUserMenu />
        <UColorModeButton />
      </div>
    </header>

    <main class="flex-1 px-6 py-8">
      <div
        v-if="loading"
        class="flex justify-center py-16"
      >
        <UIcon
          name="i-lucide-loader"
          class="size-8 animate-spin text-muted"
        />
      </div>

      <div
        v-else-if="notFound || forbidden"
        class="max-w-md mx-auto text-center space-y-4 py-16"
      >
        <UIcon
          name="i-lucide-folder-x"
          class="size-10 text-muted mx-auto"
        />
        <h1 class="text-xl font-semibold">
          {{ t('workspace.notFound') }}
        </h1>
        <p class="text-sm text-muted">
          {{ t('workspace.notFoundDesc') }}
        </p>
        <UButton
          to="/"
          variant="ghost"
          icon="i-lucide-arrow-left"
        >
          {{ t('access.backHome') }}
        </UButton>
      </div>

      <div
        v-else-if="data"
        class="max-w-3xl mx-auto space-y-6"
      >
        <!-- Header block with title + description + avatar row + actions -->
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-3 flex-wrap">
              <h1 class="text-2xl font-bold tracking-tight">
                {{ data.workspace.name }}
              </h1>
              <UBadge
                v-if="myRole !== 'admin'"
                size="xs"
                color="primary"
                variant="subtle"
              >
                {{ myRole === 'editor' ? t('workspace.roles.editor') : t('workspace.roles.viewer') }}
              </UBadge>
            </div>
            <p
              v-if="data.workspace.description"
              class="text-sm text-muted mt-2 whitespace-pre-line"
            >
              {{ data.workspace.description }}
            </p>
            <div class="mt-3">
              <WorkspaceMemberAvatars
                :members="data.members"
                @click="membersOpen = true"
              />
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              v-if="canCreateDoc"
              icon="i-lucide-plus"
              @click="createDocument"
            >
              {{ t('workspace.newDocument') }}
            </UButton>
            <UDropdownMenu :items="workspaceMenuItems">
              <UButton
                icon="i-lucide-more-vertical"
                color="neutral"
                variant="ghost"
              />
            </UDropdownMenu>
          </div>
        </div>

        <!-- AI workspace banner — visible to every member when the
             admin has turned the toggle on. Muted palette; it's a
             persistent status indicator, not a warning. -->
        <div
          v-if="data.workspace.aiEnabled"
          class="flex items-center gap-2 rounded-lg border border-default bg-default/60 px-3 py-2 text-sm text-muted"
        >
          <UIcon name="i-lucide-sparkles" class="shrink-0" />
          <span>
            This is an <strong class="text-default">AI workspace</strong> — AI work here runs on the sponsor's credit pool.
          </span>
        </div>

        <!-- Tabs split the workspace into Documents / Knowledge / AI.
             Keeps the page focused on one concern at a time now that
             there's enough to manage that cramming them vertically
             would feel cluttered. -->
        <UTabs
          v-model="activeTab"
          :items="tabItems"
          :ui="{ content: 'mt-6' }"
        >
          <template #documents>
            <div v-if="data.documents.length > 0">
              <WorkspaceDocTable
                :documents="data.documents"
                :my-role="myRole || 'viewer'"
                :workspace-id="data.workspace.workspaceId"
                @duplicate-requested="openDocDuplicate"
                @move-requested="openDocMove"
                @delete-requested="openDocDelete"
              />
            </div>
            <div
              v-else
              class="text-center py-16 border border-dashed border-default rounded-lg"
            >
              <UIcon
                name="i-lucide-file-plus"
                class="size-8 text-muted mx-auto mb-2"
              />
              <p class="text-base font-medium">
                {{ t('workspace.empty') }}
              </p>
              <p class="text-sm text-muted mt-1">
                {{ canCreateDoc ? t('workspace.emptyDescription') : t('workspace.emptyDescriptionViewer') }}
              </p>
              <UButton
                v-if="canCreateDoc"
                class="mt-4"
                icon="i-lucide-plus"
                @click="createDocument"
              >
                {{ t('workspace.newDocument') }}
              </UButton>
            </div>
          </template>

          <template #knowledge>
            <WorkspaceKnowledgePanel
              :workspace-id="data.workspace.workspaceId"
              :my-role="data.workspace.myRole"
              :my-user-id="myUserId ?? null"
            />
          </template>

          <template #ai>
            <!-- Admin-only toggle — non-admins see the read-only
                 explanation so they understand the feature without
                 being able to flip it. -->
            <WorkspaceBillingToggle
              v-if="isAdmin"
              :workspace-id="data.workspace.workspaceId"
              :ai-enabled="data.workspace.aiEnabled"
              :billing-owner-id="data.workspace.billingOwnerId"
              @updated="loadWorkspace"
            />
            <div
              v-else
              class="border border-default rounded-lg p-4 bg-default/50 text-sm text-muted"
            >
              <p v-if="data.workspace.aiEnabled">
                This workspace is an <strong>AI workspace</strong>. AI work here is sponsored by an admin.
              </p>
              <p v-else>
                This is a regular workspace. Members use their own AI credits. An admin can turn it into an AI workspace to sponsor the pool.
              </p>
            </div>
          </template>
        </UTabs>
      </div>
    </main>

    <WorkspaceFormModal
      v-if="data && isAdmin"
      v-model:open="editOpen"
      :workspace-id="data.workspace.workspaceId"
      :initial-name="data.workspace.name"
      :initial-description="data.workspace.description"
      @updated="onWorkspaceUpdated"
    />

    <WorkspaceDeleteConfirmModal
      v-if="data && isAdmin"
      v-model:open="deleteOpen"
      :workspace-id="data.workspace.workspaceId"
      :name="data.workspace.name"
      :doc-count="data.documents.length"
      @deleted="onWorkspaceDeleted"
    />

    <WorkspaceMembersModal
      v-if="data && myUserId != null"
      v-model:open="membersOpen"
      :workspace-id="data.workspace.workspaceId"
      :workspace-name="data.workspace.name"
      :members="data.members"
      :my-role="data.workspace.myRole"
      :my-user-id="myUserId"
      @updated="onMembersUpdated"
      @leave="onLeftWorkspace"
    />

    <DocumentNewDocumentDialog
      v-if="data"
      v-model:open="showNewDocDialog"
      :workspace-id="data.workspace.workspaceId"
      @created="onDocCreated"
    />

    <DocumentDeleteConfirmModal
      v-if="deleteTargetDoc"
      v-model:open="showDocDeleteConfirm"
      :doc-id="deleteTargetDoc.docId"
      :title="deleteTargetDoc.title"
      @deleted="onDocDeleted"
    />

    <DocumentDuplicateDocModal
      v-if="duplicateTargetDoc"
      v-model:open="showDuplicateModal"
      :doc-id="duplicateTargetDoc.docId"
      :source-title="duplicateTargetDoc.title"
      @duplicated="onDocDuplicated"
    />

    <DocumentMoveWorkspaceModal
      v-if="moveTargetDoc && data"
      v-model:open="showMoveModal"
      :doc-id="moveTargetDoc.docId"
      :doc-title="moveTargetDoc.title"
      :current-workspace-id="data.workspace.workspaceId"
      @moved="onDocMoved"
    />
  </div>
</template>
