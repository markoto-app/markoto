<script setup lang="ts">
import type { WorkspaceDoc } from '~/components/workspace/WorkspaceDocTable.vue'
import type { WorkspaceMember } from '~/components/workspace/WorkspaceMemberAvatars.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()
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
    else {
      toast.add({
        title: t('workspace.notFound'),
        description: e?.data?.message || e?.message,
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
  } finally {
    loading.value = false
  }
}

watch([workspaceId, loggedIn], loadWorkspace, { immediate: true })

const myRole = computed(() => data.value?.workspace.myRole ?? null)
const isAdmin = computed(() => myRole.value === 'admin')
const canCreateDoc = computed(() => myRole.value === 'admin' || myRole.value === 'editor')
const myUserId = computed(() => (user.value as any)?.id as number | undefined)

const creating = ref(false)
async function createDocument() {
  creating.value = true
  try {
    const { docId } = await $fetch<{ docId: string }>('/api/docs', {
      method: 'POST',
      body: { workspaceId: workspaceId.value }
    })
    router.push(`/d/${docId}`)
  } catch (e: any) {
    toast.add({
      title: 'Could not create document',
      description: e?.data?.message || e?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    creating.value = false
  }
}

// Modals
const editOpen = ref(false)
const deleteOpen = ref(false)
const membersOpen = ref(false)
const deleteTargetDoc = ref<WorkspaceDoc | null>(null)
const showDocDeleteConfirm = ref(false)

function openDocDelete(doc: WorkspaceDoc) {
  deleteTargetDoc.value = doc
  showDocDeleteConfirm.value = true
}

function onDocDeleted() {
  if (!deleteTargetDoc.value || !data.value) return
  data.value.documents = data.value.documents.filter(d => d.docId !== deleteTargetDoc.value!.docId)
  deleteTargetDoc.value = null
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
      <div v-if="loading" class="flex justify-center py-16">
        <UIcon name="i-lucide-loader" class="size-8 animate-spin text-muted" />
      </div>

      <div
        v-else-if="notFound || forbidden"
        class="max-w-md mx-auto text-center space-y-4 py-16"
      >
        <UIcon name="i-lucide-folder-x" class="size-10 text-muted mx-auto" />
        <h1 class="text-xl font-semibold">{{ t('workspace.notFound') }}</h1>
        <p class="text-sm text-muted">{{ t('workspace.notFoundDesc') }}</p>
        <UButton to="/" variant="ghost" icon="i-lucide-arrow-left">
          {{ t('access.backHome') }}
        </UButton>
      </div>

      <div v-else-if="data" class="max-w-3xl mx-auto space-y-6">
        <!-- Header block with title + description + avatar row + actions -->
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-3 flex-wrap">
              <h1 class="text-2xl font-bold tracking-tight">{{ data.workspace.name }}</h1>
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
              :loading="creating"
              @click="createDocument"
            >
              {{ t('workspace.newDocument') }}
            </UButton>
            <UDropdownMenu :items="workspaceMenuItems">
              <UButton icon="i-lucide-more-vertical" color="neutral" variant="ghost" />
            </UDropdownMenu>
          </div>
        </div>

        <!-- Doc list -->
        <div v-if="data.documents.length > 0">
          <WorkspaceDocTable
            :documents="data.documents"
            :my-role="myRole || 'viewer'"
            @delete-requested="openDocDelete"
          />
        </div>
        <div
          v-else
          class="text-center py-16 border border-dashed border-default rounded-lg"
        >
          <UIcon name="i-lucide-file-plus" class="size-8 text-muted mx-auto mb-2" />
          <p class="text-base font-medium">{{ t('workspace.empty') }}</p>
          <p class="text-sm text-muted mt-1">
            {{ canCreateDoc ? t('workspace.emptyDescription') : t('workspace.emptyDescriptionViewer') }}
          </p>
          <UButton
            v-if="canCreateDoc"
            class="mt-4"
            icon="i-lucide-plus"
            :loading="creating"
            @click="createDocument"
          >
            {{ t('workspace.newDocument') }}
          </UButton>
        </div>
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

    <DocumentDeleteConfirmModal
      v-if="deleteTargetDoc"
      v-model:open="showDocDeleteConfirm"
      :doc-id="deleteTargetDoc.docId"
      :title="deleteTargetDoc.title"
      @deleted="onDocDeleted"
    />
  </div>
</template>
