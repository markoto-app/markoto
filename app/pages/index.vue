<script setup lang="ts">
import type { WorkspaceListItem } from '~/components/workspace/WorkspaceList.vue'
import type { WorkspaceInviteItem } from '~/components/workspace/WorkspaceInviteList.vue'

const { t } = useI18n()
const router = useRouter()
const { loggedIn } = useUserSession()
const { billing, workspaceCapReached } = useBilling()

const toast = useToast()
const { providerName } = useLoginOptions()
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

// OAuth account-merge flash. The auth handler redirects to
// `/?linked=github`, `/?linked=google` or `/?linked=oidc` when a second-provider
// sign-in landed on an existing row (matched by verified email) and
// we added the new provider id to it. Surface a one-time toast
// explaining what happened, then strip the query param so a reload
// doesn't re-show the toast.
onMounted(() => {
  const route = useRoute()
  const linked = route.query.linked
  if (typeof linked === 'string' && (linked === 'github' || linked === 'google' || linked === 'oidc')) {
    toast.add({
      title: t('auth.linkedTitle'),
      description: t('auth.linkedDescription', { provider: providerName(linked) }),
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
  () => loggedIn.value ? $fetch<DocumentListItem[]>('/api/user/documents') : Promise.resolve([]),
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
  () => loggedIn.value ? $fetch<WorkspaceListItem[]>('/api/user/workspaces') : Promise.resolve([]),
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
    myInvites.value = await $fetch<WorkspaceInviteItem[]>('/api/user/invites')
  } catch {
    myInvites.value = []
  }
}
function onInviteRemoved(inviteId: string): void {
  myInvites.value = myInvites.value.filter(i => i.inviteId !== inviteId)
}
function onInviteAccepted(): void {
  workspacesFetched.value = false
  loadWorkspaces()
}

// Defer the load to AFTER hydration (VueUse `tryOnMounted` =
// SSR-safe `onMounted`). Two SSR↔client mismatches collapse here:
//   1) Bare `$fetch` on SSR doesn't forward the request's cookies, so
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
  }, { immediate: true })
})

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
function onDocMoved(_newWorkspaceId: string | null) {
  // The "Recent Documents" list on the dashboard shows all owned docs
  // regardless of workspace, so a move doesn't need to drop the row.
  // If the target is a workspace, the user probably wants to see the
  // doc in the workspace view — but re-fetching here is enough for
  // updated metadata. Noop for now; visible state already accurate.
  moveTarget.value = null
}

// Workspace create
const showCreateWorkspace = ref(false)

function onWorkspaceCreated(workspaceId: string) {
  router.push(`/w/${workspaceId}`)
}

// Long-press a doc row to open its action menu — discoverable on
// touch where the 3-dot button is a small target. Per-row keying so
// only the long-pressed row's menu opens. Owner-only here, mirroring
// the menu's existing visibility gate.
const openMenuDocId = ref<string | null>(null)
function onRowLongPress(doc: DocumentListItem) {
  if (!doc.isOwner) return
  openMenuDocId.value = doc.docId
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Header. The brand lockup is the wordmark + seal — the seal is
         the in-product AI presence indicator AND the standalone brand
         mark, so the dashboard shows the lockup rather than a generic
         file icon. Sentence case throughout, no Title Case Headings. -->
    <header class="border-b border-default px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
      <NuxtLink
        to="/"
        class="flex items-center"
        aria-label="markoto home"
      >
        <CommonWordmark :size="20" />
      </NuxtLink>
      <div class="flex items-center gap-2">
        <AuthUserMenu />
        <UColorModeButton />
      </div>
    </header>

    <!-- Hero. Editorial register from the homepage mockup —
         Fraunces weight 300 display, italic-400 emphasis on the
         brand's loadbearing word ("craft"), Inter lede capped at
         34ch. -->
    <main class="flex-1 flex flex-col items-center px-4 sm:px-6 py-10 sm:py-20">
      <div class="max-w-2xl text-center space-y-5 sm:space-y-7">
        <h1 class="font-serif text-[34px] sm:text-5xl md:text-6xl font-light tracking-tight leading-[1.06] sm:leading-[1.04]">
          Rethinking the <em class="italic font-normal">craft</em> of writing.
        </h1>
        <p class="text-[14px] leading-[1.65] text-muted max-w-[34ch] mx-auto">
          {{ t('landing.subtitle') }}
        </p>
        <div class="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <UButton
            size="lg"
            icon="i-lucide-plus"
            data-testid="landing-new-document"
            @click="createDocument"
          >
            {{ t('landing.newDocument') }}
          </UButton>
          <!-- At-cap pattern: stays visible, muted styling + tooltip +
               click routes to /pricing (or, with billing off on a
               self-hosted instance, explains the limit in a toast). We never hide the button (user
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
            data-testid="landing-new-workspace"
            @click="workspaceCapReached ? onCapReachedClick() : (showCreateWorkspace = true)"
          >
            {{ workspaceCapReached ? workspaceCapShortLabel : t('workspace.newWorkspace') }}
          </UButton>
        </div>
      </div>

      <!-- Pending workspace invitations addressed to this account.
           Hidden when there are none. -->
      <div
        v-if="loggedIn && myInvites.length > 0"
        class="mt-12 w-full max-w-4xl"
      >
        <h2 class="font-serif text-2xl font-normal mb-4">
          {{ t('workspace.invites.sectionTitle') }}
        </h2>
        <WorkspaceInviteList
          :invites="myInvites"
          @removed="onInviteRemoved"
          @accepted="onInviteAccepted"
        />
      </div>

      <!-- My workspaces. Mounts whenever logged-in so the loading
           spinner is visible during the SSR→hydration window AND
           during a manual refetch. After the first fetch resolves
           and there are no workspaces, the section quietly empties
           via `WorkspaceList`'s own empty fallback (`v-else`). -->
      <div
        v-if="loggedIn && (!workspacesFetched || myWorkspaces.length > 0)"
        class="mt-12 w-full max-w-4xl"
      >
        <h2 class="font-serif text-2xl font-normal mb-4">
          {{ t('workspace.sectionTitle') }}
        </h2>
        <WorkspaceList
          :workspaces="myWorkspaces"
          :loading="!workspacesFetched"
        />
      </div>

      <!-- Recent documents -->
      <div
        v-if="loggedIn && myDocs.length > 0"
        data-testid="landing-recent-documents"
        class="mt-12 w-full max-w-2xl"
      >
        <h2 class="font-serif text-2xl font-normal mb-4">
          {{ t('landing.recentDocuments') }}
        </h2>
        <div class="space-y-2">
          <div
            v-for="doc in myDocs"
            :key="doc.docId"
            v-long-press="() => onRowLongPress(doc)"
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
                :open="openMenuDocId === doc.docId"
                @update:open="(v: boolean) => { if (!v && openMenuDocId === doc.docId) openMenuDocId = null }"
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

      <!-- Recent-docs spinner. Renders during the first fetch
           regardless of cached state — `docsFetched` flips true
           after `loadDocs` resolves (success or error), so the
           indicator covers the SSR→hydration window where
           `loadingDocs` alone reports false. -->
      <div
        v-if="loggedIn && !docsFetched && myDocs.length === 0"
        class="mt-12 flex justify-center"
      >
        <UIcon
          name="i-lucide-loader"
          class="size-6 animate-spin text-primary mx-auto"
        />
      </div>
    </main>

    <CommonLegalFooter />
  </div>
</template>
