<script setup lang="ts">
import { useHydrated } from '~/composables/platform/useHydrated'
import type { ApiResponse } from '~/utils/api/client'
import type { WorkspaceListItem } from '~/components/workspace/WorkspaceList.vue'
import type { WorkspaceInviteItem } from '~/components/workspace/WorkspaceInviteList.vue'
import { useMyWorkspaces } from '~/queries/workspaces'

// The home page for everyone who doesn't get the product tour. Logged-out
// visitors see the plain hero with "New document"; signed-in users get an
// app dashboard instead: a compact page header, then their invitations,
// workspaces and documents, each section with its own create button in
// its header. Split out of pages/index.vue and mounted as a Lazy component
// there, so its code (workspace list, document modals, Nuxt UI menus and
// forms) stays out of the product page's chunks, a logged-out visitor
// on the marketing site never downloads it. The new-document dialog
// stays on the page (the tour opens it too): `new-document` asks for it.
const props = defineProps<{
  /** The open personal folder (`/f/:folderId`); null = the root. */
  folderId?: string | null
}>()

const emit = defineEmits<{
  'new-document': [folderId?: string | null]
  // Pointer over / focus on a "New document" button: fetch the dialog's
  // chunk a moment early (useNewDocDialog.warm).
  'warm-new-document': []
}>()

const { t } = useI18n()
const router = useRouter()
const marketingPath = useMarketingPath()
const { loggedIn, user } = useUserSession()
// The create buttons are server-rendered; before hydration a click on them
// would do nothing at all, so they show disabled until then.
const hydrated = useHydrated()
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
    void router.push(marketingPath('/pricing'))
    return
  }
  // Self-hosted: nothing to buy, say so instead of a dead link.
  toast.add({ title: workspaceCapShortLabel.value, description: workspaceCapTooltip.value, icon: 'i-lucide-lock', color: 'neutral' })
}

// The workspace list is a shared query (also behind "Move to workspace");
// creating, renaming, deleting, leaving or joining a workspace refreshes it.
// It starts after mount like the loads above, so the server render and
// the first client render both show the spinner ("pending").
const workspacesQuery = useMyWorkspaces()
const myWorkspaces = computed<WorkspaceListItem[]>(() => loggedIn.value ? workspacesQuery.data.value ?? [] : [])
const workspacesFetched = computed(() => workspacesQuery.status.value !== 'pending')
watch(() => workspacesQuery.error.value, (e) => {
  if (e) showContextualError(e, 'error.generic')
})

// Open workspace invitations addressed to this account. Failures are
// non-fatal (the section just stays hidden), the workspace list and
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
// Documents shared with this account as a workspace GUEST, a
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
  // The accept mutation already refreshed the workspace list.
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
    void router.replace({ path: '/invites/accept', query: { token: pendingInvite } })
    return
  }
  watch(loggedIn, () => {
    void loadInvites()
    void loadSharedDocs()
  }, { immediate: true })
})

// Compact dashboard header: a greeting when we know the name, else "Home".
const pageTitle = computed(() => {
  const name = user.value?.name?.trim()
  return name ? t('home.greeting', { name }) : t('home.title')
})

const showCreateWorkspace = ref(false)

// The personal documents explorer lives at `/` and `/f/:folderId`.
function folderHref(id: string | null): string {
  return id === null ? '/' : `/f/${encodeURIComponent(id)}`
}

function onWorkspaceCreated(workspaceId: string) {
  void router.push(`/w/${workspaceId}`)
}
</script>

<template>
  <main
    class="flex-1 flex flex-col items-center px-4 sm:px-6"
    :class="loggedIn ? 'py-6 sm:py-10' : 'py-10 sm:py-20'"
  >
    <!-- Logged out: the plain hero. Editorial register from the homepage
         mockup: Fraunces weight 300 display, italic-400 emphasis on the
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
          :disabled="!hydrated"
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
      class="w-full max-w-6xl space-y-10 sm:space-y-12"
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
            :variant="workspaceCapReached ? 'ghost' : 'solid'"
            :icon="workspaceCapReached ? 'i-lucide-lock' : 'i-lucide-folder-plus'"
            :class="workspaceCapReached ? 'opacity-60' : ''"
            :title="workspaceCapReached ? workspaceCapTooltip : undefined"
            :disabled="!hydrated"
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
          <div class="flex-1" />
          <ExplorerQuickSearch />
          <UButton
            size="sm"
            color="neutral"
            icon="i-lucide-plus"
            :disabled="!hydrated"
            data-testid="landing-new-document"
            @click="emit('new-document', props.folderId ?? null)"
            @pointerenter="emit('warm-new-document')"
            @focus="emit('warm-new-document')"
          >
            {{ t('landing.newDocument') }}
          </UButton>
        </div>

        <ExplorerView
          :scope="{ kind: 'personal' }"
          access="owner"
          :folder-id="props.folderId ?? null"
          :root-label="t('explorer.personalRoot')"
          :folder-href="folderHref"
          @new-document="(f: string | null) => emit('new-document', f)"
        />
      </section>
    </div>

    <!-- Create workspace modal -->
    <WorkspaceFormModal
      v-model:open="showCreateWorkspace"
      @created="onWorkspaceCreated"
    />
  </main>
</template>
