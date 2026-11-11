<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'
import type { WorkspaceListItem } from '~/components/workspace/WorkspaceList.vue'
import type { WorkspaceInviteItem } from '~/components/workspace/WorkspaceInviteList.vue'

// The home page for everyone who doesn't get the product tour. Logged-out
// visitors see the plain hero with "New document"; signed-in users get an
// app dashboard instead — a compact page header, then their invitations,
// workspaces and documents, each section with its own create button in
// its header. Split out of pages/index.vue and mounted as a Lazy component
// there, so its code (workspace list, document modals, Nuxt UI menus and
// forms) stays out of the product page's chunks — a logged-out visitor
// on the marketing site never downloads it. The new-document dialog
// stays on the page (the tour opens it too): `new-document` asks for it.
const emit = defineEmits<{
  'new-document': []
  // Pointer over / focus on a "New document" button: fetch the dialog's
  // chunk a moment early (useNewDocDialog.warm).
  'warm-new-document': []
}>()

const { t } = useI18n()
const router = useRouter()
const { loggedIn, user } = useUserSession()
const { billing, workspaceCapReached } = useBilling()
const toast = useToast()
const { showContextualError } = useErrorHandler()

// Tooltip shown when the user tries to hover the disabled
// "New workspace" button. Concrete numbers so the limit is visible;
// upgrade path advertised on the second line.
// Billing off → no plan name, no "upgrade"; on the hosted free-only
// SaaS the tooltip adds "paid plans are coming soon".
const { billingEnabled, plansComingSoon, pricingVisible } = useBillingMode()
const workspaceCapTooltip = computed(() => {
  const b = billing.value
  if (!b) return ''
  if (billingEnabled.value) {
    return t('workspace.capReached', {
      used: b.ownedWorkspaces,
      limit: b.workspacesOwnedLimit,
      plan: b.plan.charAt(0).toUpperCase() + b.plan.slice(1)
    })
  }
  const msg = t('workspace.capReachedFree', { used: b.ownedWorkspaces, limit: b.workspacesOwnedLimit })
  return plansComingSoon.value ? `${msg} ${t('billing.comingSoonHint')}` : msg
})
const workspaceCapShortLabel = computed(() =>
  billingEnabled.value ? t('workspace.capReachedShort') : t('workspace.capReachedShortFree')
)

function onCapReachedClick() {
  if (pricingVisible.value) {
    router.push('/pricing')
    return
  }
  // Self-hosted: nothing to buy — say so instead of a dead link.
  toast.add({ title: workspaceCapShortLabel.value, description: workspaceCapTooltip.value, icon: 'i-lucide-lock', color: 'neutral' })
}

type DocumentListItem = ApiResponse<'/api/user/documents', 'get'>[number]

// Track "has the first fetch resolved" explicitly. `useAsyncState` with
// `immediate: false` reports `isLoading: false` until the first
// `execute()` lands, which means the spinner gated on `loadingDocs`
// alone is invisible during the SSR→hydration window — by the time
// `tryOnMounted` fires `loadDocs`, the response often comes back
// faster than a frame, so the user never sees a spinner. These flags
// stay false until the first fetch resolves; the v-if uses them to
// show the spinner consistently across SSR + the brief load window.
const docsFetched = ref(false)
const workspacesFetched = ref(false)

const {
  state: myDocs,
  isLoading: _loadingDocs,
  execute: loadDocs
} = useAsyncState<DocumentListItem[]>(
  () => loggedIn.value ? apiFetch('/api/user/documents') : Promise.resolve([]),
  [],
  {
    immediate: false,
    resetOnExecute: false,
    onError: (e) => {
      myDocs.value = []
      docsFetched.value = true
      showContextualError(e, 'error.generic')
    },
    onSuccess: () => { docsFetched.value = true }
  }
)

const {
  state: myWorkspaces,
  isLoading: _loadingWorkspaces,
  execute: loadWorkspaces
} = useAsyncState<WorkspaceListItem[]>(
  () => loggedIn.value ? apiFetch('/api/user/workspaces') : Promise.resolve([]),
  [],
  {
    immediate: false,
    resetOnExecute: false,
    onError: (e) => {
      myWorkspaces.value = []
      workspacesFetched.value = true
      showContextualError(e, 'error.generic')
    },
    onSuccess: () => { workspacesFetched.value = true }
  }
)

// Open workspace invitations addressed to this account. Failures are
// non-fatal (the section just stays hidden) — the workspace list and
// documents are the primary content of the dashboard.
const myInvites = ref<WorkspaceInviteItem[]>([])
async function loadInvites(): Promise<void> {
  if (!loggedIn.value) {
    myInvites.value = []
    return
  }
  try {
    myInvites.value = await apiFetch('/api/user/invites')
  } catch {
    myInvites.value = []
  }
}
// Documents shared with this account as a workspace GUEST — a
// guest's only way into a workspace. Hidden when there are none.
type SharedDoc = ApiResponse<'/api/user/shared-documents', 'get'>[number]
const sharedDocs = ref<SharedDoc[]>([])
async function loadSharedDocs(): Promise<void> {
  if (!loggedIn.value) {
    sharedDocs.value = []
    return
  }
  try {
    sharedDocs.value = await apiFetch('/api/user/shared-documents')
  } catch {
    sharedDocs.value = []
  }
}

function onInviteRemoved(inviteId: string): void {
  myInvites.value = myInvites.value.filter(i => i.inviteId !== inviteId)
}
function onInviteAccepted(): void {
  workspacesFetched.value = false
  loadWorkspaces()
  void loadSharedDocs()
}

// Defer the load to AFTER hydration (VueUse `tryOnMounted` =
// SSR-safe `onMounted`). Two SSR↔client mismatches collapse here:
//   1) A bare client fetch on SSR doesn't forward the request's cookies, so
//      the server sees an anonymous call and 401s → onError toast
//      lands in the SSR HTML, but the client toast queue starts empty
//      → `<ToastRoot>` hydration mismatch → app crash.
//   2) Setup-time `immediate: true` flips `loadingWorkspaces` true
//      before the first paint, but SSR rendered with loading=false →
//      the workspace section's v-if differs SSR (false → comment) vs
//      client (true → div) → "Hydration node mismatch at <Index>".
// `tryOnMounted` runs only on the client, after the first paint, so
// SSR HTML and client first render agree; the spinner appears on the
// next tick. See the equivalent guard in app/pages/w/[id].vue.
tryOnMounted(() => {
  // Back from signing in to accept an emailed workspace invitation
  // (every OAuth callback lands on `/`): return to the accept page.
  const pendingInvite = loggedIn.value ? readPendingInviteToken() : null
  if (pendingInvite) {
    clearPendingInviteToken()
    router.replace({ path: '/invites/accept', query: { token: pendingInvite } })
    return
  }
  watch(loggedIn, () => {
    docsFetched.value = false
    workspacesFetched.value = false
    loadDocs()
    loadWorkspaces()
    void loadInvites()
    void loadSharedDocs()
  }, { immediate: true })
})

// Compact dashboard header: a greeting when we know the name, else "Home".
const pageTitle = computed(() => {
  const name = user.value?.name?.trim()
  return name ? t('home.greeting', { name }) : t('home.title')
})

const deleteTarget = ref<DocumentListItem | null>(null)
const showDeleteConfirm = ref(false)

function openDeleteConfirm(doc: DocumentListItem) {
  deleteTarget.value = doc
  showDeleteConfirm.value = true
}

function onDocDeleted() {
  const target = deleteTarget.value
  if (!target) return
  // Optimistically remove from list (the server call already succeeded at this point)
  myDocs.value = myDocs.value.filter(d => d.docId !== target.docId)
  deleteTarget.value = null
}

// Duplicate / Move modals. Dashboard shows personal + owned-in-workspace
// docs; every entry here is owned by the caller (`isOwner`), so the menu
// offers every action — `isOwner` is still passed through as the gate.
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
  // The documents list shows every owned doc regardless of workspace,
  // so a move keeps the row; record the new workspace so a second Move
  // starts from the right place.
  const target = moveTarget.value
  if (target) {
    myDocs.value = myDocs.value.map(d => d.docId === target.docId ? { ...d, workspaceId: newWorkspaceId } : d)
  }
  moveTarget.value = null
}

const showCreateWorkspace = ref(false)

function onWorkspaceCreated(workspaceId: string) {
  router.push(`/w/${workspaceId}`)
}

// Long-press a doc row to open its action menu — discoverable on
// touch where the 3-dot button is a small target. Per-row keying so
// only the long-pressed row's menu opens. The trigger writes the same
// state (two-way), so a click opens the menu as well.
const openMenuDocId = ref<string | null>(null)
function onRowLongPress(doc: DocumentListItem) {
  openMenuDocId.value = doc.docId
}
function setMenuOpen(doc: DocumentListItem, open: boolean) {
  if (open) openMenuDocId.value = doc.docId
  else if (openMenuDocId.value === doc.docId) openMenuDocId.value = null
}
</script>

<template>
  <main
    class="flex-1 flex flex-col items-center px-4 sm:px-6"
    :class="loggedIn ? 'py-6 sm:py-10' : 'py-10 sm:py-20'"
  >
    <!-- Logged out: the plain hero. Editorial register from the homepage
         mockup — Fraunces weight 300 display, italic-400 emphasis on the
         brand's loadbearing word ("Markdown"), Inter lede capped at 34ch. -->
    <div
      v-if="!loggedIn"
      class="max-w-2xl text-center space-y-5 sm:space-y-7"
    >
      <i18n-t
        keypath="landing.hero"
        tag="h1"
        scope="global"
        class="font-serif text-[34px] sm:text-5xl md:text-6xl font-light tracking-tight leading-[1.06] sm:leading-[1.04]"
      >
        <template #markdown>
          <em class="italic font-normal">{{ t('landing.heroMarkdown') }}</em>
        </template>
      </i18n-t>
      <p class="text-[14px] leading-[1.65] text-muted max-w-[34ch] mx-auto">
        {{ t('landing.subtitle') }}
      </p>
      <div class="flex justify-center">
        <UButton
          size="lg"
          icon="i-lucide-plus"
          data-testid="landing-new-document"
          @click="emit('new-document')"
          @pointerenter="emit('warm-new-document')"
          @focus="emit('warm-new-document')"
        >
          {{ t('landing.newDocument') }}
        </UButton>
      </div>
    </div>

    <!-- Logged in: an app dashboard, not a landing page. -->
    <div
      v-else
      class="w-full max-w-4xl space-y-10 sm:space-y-12"
      data-testid="home-dashboard"
    >
      <UPageHeader
        :title="pageTitle"
        :description="t('home.description')"
        :ui="{
          root: 'border-b border-default/60 pt-0 pb-5 sm:pb-6',
          title: 'font-serif text-2xl sm:text-3xl font-normal tracking-tight text-default',
          description: 'text-sm text-muted'
        }"
        data-testid="home-page-header"
      />

      <!-- Pending workspace invitations addressed to this account.
           Hidden when there are none. -->
      <section
        v-if="myInvites.length > 0"
        class="space-y-4"
      >
        <h2 class="font-serif text-2xl font-normal tracking-tight">
          {{ t('workspace.invites.sectionTitle') }}
        </h2>
        <WorkspaceInviteList
          :invites="myInvites"
          @removed="onInviteRemoved"
          @accepted="onInviteAccepted"
        />
      </section>

      <!-- Shared with you as a guest of a workspace. -->
      <section
        v-if="sharedDocs.length > 0"
        class="space-y-4"
        data-testid="home-shared-documents"
      >
        <h2 class="font-serif text-2xl font-normal tracking-tight">
          {{ t('landing.sharedWithYou') }}
        </h2>
        <div class="space-y-2">
          <NuxtLink
            v-for="doc in sharedDocs"
            :key="doc.docId"
            :to="`/d/${doc.docId}`"
            class="flex items-center gap-3 p-3 rounded-lg border border-default bg-default hover:bg-muted/50 transition-colors"
            :data-testid="`home-shared-document-${doc.docId}`"
          >
            <UIcon
              name="i-lucide-file-text"
              class="size-5 text-muted shrink-0"
            />
            <div class="min-w-0 flex-1">
              <p class="font-serif text-base font-normal tracking-tight truncate">
                {{ doc.title }}
              </p>
              <p class="text-xs text-muted truncate">
                {{ doc.workspaceName }}
              </p>
            </div>
            <span class="font-mono text-[10.5px] lowercase tracking-[0.04em] text-muted shrink-0">
              {{ doc.access === 'edit' ? t('share.guests.edit') : t('share.guests.view') }}
            </span>
          </NuxtLink>
        </div>
      </section>

      <!-- My workspaces. Always mounted for signed-in users so the
           create button has a home; `WorkspaceList` shows the spinner
           during the first fetch and its own empty line after. -->
      <section class="space-y-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h2 class="font-serif text-2xl font-normal tracking-tight">
            {{ t('workspace.sectionTitle') }}
          </h2>
          <!-- At-cap pattern: stays visible, muted styling + tooltip +
               click routes to /pricing (or, with billing off on a
               self-hosted instance, explains the limit in a toast). We
               never hide the button (the user should still see the
               feature exists) and never silently no-op on click. The
               native `disabled` attribute is NOT used because that
               would also suppress the click. -->
          <UButton
            size="sm"
            color="neutral"
            :variant="workspaceCapReached ? 'ghost' : 'subtle'"
            :icon="workspaceCapReached ? 'i-lucide-lock' : 'i-lucide-folder-plus'"
            :class="workspaceCapReached ? 'opacity-60' : ''"
            :title="workspaceCapReached ? workspaceCapTooltip : undefined"
            data-testid="landing-new-workspace"
            @click="workspaceCapReached ? onCapReachedClick() : (showCreateWorkspace = true)"
          >
            {{ workspaceCapReached ? workspaceCapShortLabel : t('workspace.newWorkspace') }}
          </UButton>
        </div>
        <WorkspaceList
          :workspaces="myWorkspaces"
          :loading="!workspacesFetched"
        />
      </section>

      <!-- My documents -->
      <section
        data-testid="landing-recent-documents"
        class="space-y-4"
      >
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h2 class="font-serif text-2xl font-normal tracking-tight">
            {{ t('landing.recentDocuments') }}
          </h2>
          <UButton
            size="sm"
            color="neutral"
            icon="i-lucide-plus"
            data-testid="landing-new-document"
            @click="emit('new-document')"
            @pointerenter="emit('warm-new-document')"
            @focus="emit('warm-new-document')"
          >
            {{ t('landing.newDocument') }}
          </UButton>
        </div>

        <!-- Spinner during the first fetch — `docsFetched` flips true
             after `loadDocs` resolves (success or error), so it covers
             the SSR→hydration window where `isLoading` alone reports
             false. -->
        <div
          v-if="!docsFetched && myDocs.length === 0"
          class="flex justify-center py-6"
        >
          <UIcon
            name="i-lucide-loader"
            class="size-6 animate-spin text-muted mx-auto"
          />
        </div>
        <p
          v-else-if="myDocs.length === 0"
          class="text-sm text-muted"
          data-testid="home-no-documents"
        >
          {{ t('landing.noRecent') }}
        </p>
        <div
          v-else
          class="space-y-2"
        >
          <div
            v-for="doc in myDocs"
            :key="doc.docId"
            v-long-press="() => onRowLongPress(doc)"
            class="group flex items-center gap-3 p-3 rounded-lg border border-default bg-default hover:bg-muted/50 transition-colors"
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
                <p class="font-serif text-base font-normal tracking-tight truncate">{{ doc.title }}</p>
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
                <p class="text-xs text-muted">
                  <CommonTimeAgo :ts="doc.lastActive" />
                </p>
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
              <span class="hidden sm:inline text-xs text-muted">{{ doc.wordCount || 0 }} words</span>
              <DocumentDocRowMenu
                :doc-id="doc.docId"
                :can-edit="!!doc.isOwner"
                :can-manage="!!doc.isOwner"
                :open="openMenuDocId === doc.docId"
                @update:open="(v: boolean) => setMenuOpen(doc, v)"
                @duplicate="openDuplicate(doc)"
                @move="openMove(doc)"
                @delete="openDeleteConfirm(doc)"
              />
            </div>
          </div>
        </div>
      </section>
    </div>

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
  </main>
</template>
