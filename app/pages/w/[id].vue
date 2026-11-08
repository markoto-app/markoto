<script setup lang="ts">
import type { WorkspaceDoc } from '~/components/workspace/WorkspaceDocTable.vue'
import type { WorkspaceMember } from '~/components/workspace/WorkspaceMemberAvatars.vue'
import { sponsorshipTabVisible } from '~~/shared/config/sponsorship'

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
    // NEW: workspace default theme. NULL = use the markoto preset.
    // Read by NewDocumentDialog when seeding the theme card grid for
    // docs created in this workspace.
    defaultTheme: import('~~/shared/types/theme').DocTheme | null
  }
  documents: WorkspaceDoc[]
  members: WorkspaceMember[]
}

const notFound = ref(false)
const forbidden = ref(false)

const {
  state: data,
  isLoading: loading,
  execute: loadWorkspace
} = useAsyncState<WorkspaceDetail | null, [], false>(
  async () => {
    notFound.value = false
    forbidden.value = false
    return await $fetch<WorkspaceDetail>(`/api/workspaces/${workspaceId.value}`)
  },
  null,
  {
    immediate: false,
    resetOnExecute: false,
    // Deep-reactive: callers mutate `data.value.documents = …` and
    // `data.value.workspace.name = …` post-load. shallowRef (the
    // useAsyncState default) wouldn't notify on those nested writes.
    shallow: false,
    onError: (e: unknown) => {
      const err = e as { statusCode?: number } | null
      if (err?.statusCode === 404) notFound.value = true
      else if (err?.statusCode === 403 || err?.statusCode === 401) forbidden.value = true
      else showError('workspace.notFound', e)
    }
  }
)

// Defer to VueUse `tryOnMounted` — see app/pages/index.vue for the
// full rationale (SSR cookie-less $fetch + setup-time loading-flag
// flip both cause hydration mismatches; deferring to client mount
// sidesteps both).
tryOnMounted(() => {
  watch([workspaceId, loggedIn], () => loadWorkspace(), { immediate: true })
})

// Tab title tracks the workspace name once it loads. Function getter
// keeps it reactive without polling.
useHead({
  title: () => data.value?.workspace.name
})

const myRole = computed(() => data.value?.workspace.myRole ?? null)
const isAdmin = computed(() => myRole.value === 'admin')
const canCreateDoc = computed(() => myRole.value === 'admin' || myRole.value === 'editor')
const myUserId = computed(() => (user.value as { id?: number } | null)?.id)

// Tabs split the workspace into three concerns. Default is Documents
// since that's what most visits are about. Nuxt UI v4's UTabs needs
// `value` on each item for v-model binding; `slot` picks the template.
const activeTab = ref<'documents' | 'knowledge' | 'ai' | 'settings'>('documents')
const { mode: billingMode, billingEnabled, plansComingSoon } = useBillingMode()
const tabItems = computed(() => {
  const items: Array<{ label: string, icon?: string, slot: 'documents' | 'knowledge' | 'ai' | 'settings', value: string }> = [
    { label: t('workspace.tabs.documents'), icon: 'i-lucide-file-text', slot: 'documents', value: 'documents' },
    { label: t('workspace.tabs.knowledge'), icon: 'i-lucide-library', slot: 'knowledge', value: 'knowledge' }
  ]
  // The AI-workspace tab is `(+)` sponsorship — a paid-plan feature.
  // Billing on → the real toggle. Hosted free SaaS (plans coming soon) →
  // shown, but disabled with a "coming with paid plans" note, so people
  // see the option exists. Self-hosted (no upgrade path) → hidden.
  // No `icon` for the AI tab — UTabs would render it as a Lucide
  // glyph, but the seal is a Vue component, not an Iconify name. The
  // seal sits inside the Fraunces-titled section header within the
  // tab content instead, where it carries equal weight without
  // needing to squeeze into the icon slot.
  if (sponsorshipTabVisible(billingMode.value)) {
    items.push({ label: t('workspace.tabs.ai'), slot: 'ai', value: 'ai' })
  }
  // Admin-only Settings tab. Hidden for editors / viewers — there's
  // nothing actionable for them there. Putting the gate at tab-list
  // level (rather than inside the slot) means the tab strip is the
  // same width for everyone but the order shifts.
  if (isAdmin.value) {
    items.push({ label: t('workspace.tabs.settings'), icon: 'i-lucide-settings', slot: 'settings', value: 'settings' })
  }
  return items
})

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
// "Invite people" opens the same Members modal with the email field
// focused; the avatar row / menu open it without focusing.
const membersFocusInvite = ref(false)
function openMembers(focusInvite: boolean) {
  membersFocusInvite.value = focusInvite
  membersOpen.value = true
}
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
interface MenuItem {
  label: string
  icon: string
  color?: string
  onSelect: () => void
}

const workspaceMenuItems = computed(() => {
  if (!data.value) return []
  const items: MenuItem[] = [
    {
      label: t('workspace.members.manageTitle'),
      icon: 'i-lucide-users',
      onSelect: () => openMembers(false)
    }
  ]
  if (isAdmin.value) {
    items.push(
      {
        label: t('workspace.edit'),
        icon: 'i-lucide-pencil',
        onSelect: () => { editOpen.value = true }
      },
      {
        label: t('workspace.delete'),
        icon: 'i-lucide-trash-2',
        color: 'error',
        onSelect: () => { deleteOpen.value = true }
      }
    )
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
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('workspace.members.leaveFailed'),
      description: err?.data?.message || err?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Workspace header. Lockup → back → workspace name, divided by
         hairline rules so the brand mark stays the leftmost anchor on
         every screen. The folder icon (previously shu) is dropped —
         workspace identity is carried by name + Back, and shu stays
         reserved for AI presence. -->
    <header class="border-b border-default px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
      <div class="flex items-center gap-3 min-w-0">
        <NuxtLink
          to="/"
          class="flex items-center"
          aria-label="markoto home"
        >
          <CommonWordmark :size="20" />
        </NuxtLink>
        <span
          class="block w-px h-5 bg-default/60 shrink-0"
          aria-hidden="true"
        />
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-arrow-left"
          size="sm"
          to="/"
          :aria-label="t('workspace.backToHome')"
        >
          <span class="hidden sm:inline">{{ t('workspace.backToHome') }}</span>
        </UButton>
        <span
          class="block w-px h-5 bg-default/60 shrink-0"
          aria-hidden="true"
        />
        <span class="font-serif text-lg font-normal truncate">
          {{ data?.workspace.name || t('app.name') }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <AuthUserMenu />
        <UColorModeButton />
      </div>
    </header>

    <main class="flex-1 px-3 sm:px-6 py-4 sm:py-8">
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
        <h1 class="font-serif text-2xl font-normal tracking-tight">
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
        class="max-w-3xl mx-auto space-y-4 sm:space-y-6"
      >
        <!-- Header block with title + description + avatar row + actions -->
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-3 flex-wrap">
              <!-- Workspace title in the editorial register — Fraunces
                   serif, weight 400, tight tracking. Same display as
                   the doc title in the editor toolbar; one consistent
                   editorial voice for every "name of an object" in the
                   product. -->
              <h1 class="font-serif text-2xl sm:text-3xl font-normal tracking-tight min-w-0 break-words">
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
            <!-- Gap between workspace description and the member
                 roster — `mt-3` was too tight, the member rows
                 visually merged with the description prose. -->
            <div class="mt-6">
              <WorkspaceMemberAvatars
                :members="data.members"
                @click="openMembers(false)"
              />
            </div>
          </div>
          <!-- Page-level actions. The "New document" button used to
               sit here, but it belongs inside the Documents tab — a
               page-level CTA implies "this is THE primary action" and
               on Knowledge / AI tabs that's misleading. The dropdown
               (rename / delete / members) stays — it's truly page-level.
               "Invite people" is the admins' primary page action: a
               visible button, not an entry buried in the members modal. -->
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              v-if="isAdmin"
              icon="i-lucide-user-plus"
              color="neutral"
              :aria-label="t('workspace.members.invitePeople')"
              data-testid="workspace-invite-people"
              @click="openMembers(true)"
            >
              <span class="hidden sm:inline">{{ t('workspace.members.invitePeople') }}</span>
            </UButton>
            <UDropdownMenu :items="workspaceMenuItems">
              <UButton
                icon="i-lucide-more-vertical"
                color="neutral"
                variant="ghost"
                :aria-label="t('workspace.actions')"
              />
            </UDropdownMenu>
          </div>
        </div>

        <!-- AI workspace banner — visible to every member when the
             admin has turned the toggle on. The seal stands in for
             the old sparkle icon; this banner is genuine AI presence
             so it's the one place a small shu accent is correct. -->
        <div
          v-if="billingEnabled && data.workspace.aiEnabled"
          class="flex items-center gap-2.5 rounded-lg border border-default bg-default px-3 py-2 text-sm text-muted"
        >
          <CommonSeal
            :size="10"
            class="shrink-0"
          />
          <span>{{ t('workspace.sponsorship.banner') }}</span>
        </div>

        <!--
          Tabs. variant=link swaps the shu pill for a subtle
          underlined-tab register that fits the editorial chrome.
          color=neutral makes the active underline sumi-950 instead
          of shu — shu stays reserved for AI presence. The label slot
          upgrades the tab text to Fraunces serif so tabs read as
          section titles, not chrome buttons.
        -->
        <UTabs
          v-model="activeTab"
          :items="tabItems"
          variant="link"
          color="neutral"
          :ui="{
            list: 'border-b border-default/60 gap-4 sm:gap-6 overflow-x-auto',
            trigger: 'data-[state=active]:text-default text-muted hover:text-default px-0 py-2.5 shrink-0',
            label: 'font-serif text-base font-normal tracking-tight',
            content: 'mt-6 sm:mt-8'
          }"
        >
          <template #documents>
            <!-- Same header pattern as the Knowledge tab: icon +
                 Fraunces serif title + JetBrains Mono micro-count,
                 description below, primary action right-aligned. The
                 page-level "New document" button moved here so the
                 CTA only fires when the user is actually looking at
                 the documents list. -->
            <section class="space-y-3">
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <div class="flex items-center gap-2.5 min-w-0">
                  <UIcon
                    name="i-lucide-file-text"
                    class="text-toned size-5 shrink-0"
                  />
                  <h2 class="font-serif text-2xl font-normal tracking-tight">
                    {{ t('workspace.tabs.documents') }}
                  </h2>
                  <span
                    v-if="data.documents.length > 0"
                    class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
                  >{{ data.documents.length }}</span>
                </div>
                <UButton
                  v-if="canCreateDoc"
                  icon="i-lucide-plus"
                  size="sm"
                  color="neutral"
                  data-testid="workspace-new-document"
                  @click="createDocument"
                >
                  {{ t('workspace.newDocument') }}
                </UButton>
              </div>
              <p class="text-xs text-muted">
                {{ canCreateDoc ? t('workspace.emptyDescription') : t('workspace.emptyDescriptionViewer') }}
              </p>

              <div
                v-if="data.documents.length > 0"
                class="pt-2"
              >
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
                class="text-center py-12 border border-dashed border-default rounded-lg bg-default"
              >
                <UIcon
                  name="i-lucide-file-plus"
                  class="size-6 text-muted mx-auto mb-2"
                />
                <p class="font-serif text-lg font-normal tracking-tight">
                  {{ t('workspace.empty') }}
                </p>
              </div>
            </section>
          </template>

          <template #knowledge>
            <WorkspaceKnowledgePanel
              :workspace-id="data.workspace.workspaceId"
              :my-role="data.workspace.myRole"
              :my-user-id="myUserId ?? null"
            />
          </template>

          <template #ai>
            <!-- AI workspace tab — same header pattern as Documents
                 and Knowledge: seal anchor (this is the one place
                 where shu is correct — genuine AI presence) + Fraunces
                 title + description, then the toggle/state below. -->
            <section class="space-y-3">
              <div class="flex items-center justify-between gap-3 flex-wrap">
                <div class="flex items-center gap-2.5 min-w-0">
                  <CommonSeal
                    :size="14"
                    class="shrink-0"
                  />
                  <h2 class="font-serif text-2xl font-normal tracking-tight">
                    markoto
                  </h2>
                </div>
              </div>
              <p class="text-xs text-muted">
                {{ t('workspace.sponsorship.description') }}
              </p>

              <!-- Admin-only toggle — non-admins see the read-only
                   explanation so they understand the feature without
                   being able to flip it. While paid plans are only
                   "coming soon" the toggle shows disabled with a note
                   (WorkspaceBillingToggle). -->
              <div class="pt-2">
                <WorkspaceBillingToggle
                  v-if="isAdmin"
                  :workspace-id="data.workspace.workspaceId"
                  :ai-enabled="data.workspace.aiEnabled"
                  :billing-owner-id="data.workspace.billingOwnerId"
                  @updated="() => loadWorkspace()"
                />
                <div
                  v-else
                  class="border border-default rounded-lg p-4 bg-default text-sm text-muted"
                >
                  <p v-if="!billingEnabled && plansComingSoon">
                    {{ t('workspace.sponsorship.memberComingSoon') }}
                  </p>
                  <p v-else-if="data.workspace.aiEnabled">
                    {{ t('workspace.sponsorship.memberSponsored') }}
                  </p>
                  <p v-else>
                    {{ t('workspace.sponsorship.memberRegular') }}
                  </p>
                </div>
              </div>
            </section>
          </template>

          <template #settings>
            <!-- Workspace settings — admin-only. Currently houses the
                 default-theme picker; future workspace-wide settings
                 (e.g. retention policy) sit here too. -->
            <WorkspaceSettingsPanel
              :workspace-id="data.workspace.workspaceId"
              :default-theme="data.workspace.defaultTheme"
              @updated="(theme) => { if (data) data.workspace.defaultTheme = theme }"
            />
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
      :focus-invite="membersFocusInvite"
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
