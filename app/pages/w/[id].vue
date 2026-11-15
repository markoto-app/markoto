<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ApiResponse } from '~/utils/api/client'
import { apiErrorData, errorStatus } from '~/utils/api/errors'
import type { WorkspaceDoc } from '~/components/workspace/WorkspaceDocTable.vue'
import { isPaymentProblem } from '~/utils/billing/workspaceBilling'
import type { WorkspaceMember } from '~/components/workspace/WorkspaceMemberAvatars.vue'
import { useRemoveMember } from '~/queries/workspaces'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { showError, extractError } = useErrorHandler()
const { loggedIn, user } = useUserSession()

const workspaceId = computed(() => route.params.id as string)

type WorkspaceDetail = ApiResponse<'/api/workspaces/:wsId', 'get'>

const notFound = ref(false)
const forbidden = ref(false)
// Single sign-on enforced and no current sign-in through the workspace's
// IdP: where to sign in, and whether this admin may still manage
// the connection (the break-glass).
const ssoRequired = ref<{ loginUrl: string, canManageSso: boolean } | null>(null)

const {
  state: data,
  isLoading: loading,
  execute: loadWorkspace
} = useAsyncState<WorkspaceDetail | null, [], false>(
  async () => {
    notFound.value = false
    forbidden.value = false
    ssoRequired.value = null
    return await apiFetch('/api/workspaces/:wsId', { path: { wsId: workspaceId.value } })
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
      const status = errorStatus(e)
      const sso = apiErrorData(e)
      if (status === 403 && sso?.code === 'sso/required' && typeof sso.loginUrl === 'string' && sso.loginUrl) {
        ssoRequired.value = { loginUrl: sso.loginUrl, canManageSso: sso.canManageSso === true }
      } else if (status === 404) notFound.value = true
      else if (status === 403 || status === 401) forbidden.value = true
      else showError('workspace.notFound', e)
    }
  }
)

// Defer to VueUse `tryOnMounted`, see app/pages/index.vue for the
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

// A Team / Business workspace pays its members' AI from its pool: the
// header's AI Points meter shows that budget here, as in its documents.
useClaimAiWorkspaceContext(() => {
  const ws = data.value?.workspace
  return ws?.pooled && ws.myRole && ws.workspaceId === workspaceId.value ? ws.workspaceId : null
})
const isAdmin = computed(() => myRole.value === 'admin')
const canCreateDoc = computed(() => myRole.value === 'admin' || myRole.value === 'editor')
const myUserId = computed(() => (user.value as { id?: number } | null)?.id)

// Tabs split the workspace into three concerns. Default is Documents
// since that's what most visits are about. Nuxt UI v4's UTabs needs
// `value` on each item for v-model binding; `slot` picks the template.
type WorkspaceTab = 'documents' | 'knowledge' | 'settings' | 'usage' | 'brand' | 'billing' | 'sso' | 'audit'
const initialTab = route.query.tab === 'billing' || route.query.billing || route.query.credits ? 'billing' : route.query.tab === 'sso' ? 'sso' : route.query.tab === 'audit' ? 'audit' : route.query.tab === 'usage' ? 'usage' : route.query.tab === 'brand' ? 'brand' : 'documents'
const activeTab = ref<WorkspaceTab>(initialTab)
const { billingEnabled } = useBillingMode()
const tabItems = computed(() => {
  const items: Array<{ label: string, icon?: string, slot: WorkspaceTab, value: string }> = [
    { label: t('workspace.tabs.documents'), icon: 'i-lucide-file-text', slot: 'documents', value: 'documents' },
    { label: t('workspace.tabs.knowledge'), icon: 'i-lucide-library', slot: 'knowledge', value: 'knowledge' }
  ]
  // Admin-only Settings tab. Hidden for editors / viewers, there's
  // nothing actionable for them there. Putting the gate at tab-list
  // level (rather than inside the slot) means the tab strip is the
  // same width for everyone but the order shifts.
  if (isAdmin.value) {
    items.push({ label: t('workspace.tabs.settings'), icon: 'i-lucide-settings', slot: 'settings', value: 'settings' })
    // Usage per person, every plan.
    items.push({ label: t('workspace.tabs.usage'), icon: 'i-lucide-chart-no-axes-column', slot: 'usage', value: 'usage' })
  }
  // Brand kit: admins, where the plan includes it or something is
  // set up (so it can be cleared after a downgrade).
  const brand = data.value?.workspace.brandKit
  if (isAdmin.value && brand && (brand.available || brand.inUse)) {
    items.push({ label: t('workspace.tabs.brand'), icon: 'i-lucide-palette', slot: 'brand', value: 'brand' })
  }
  // Team / Business billing: admins, and only where something can
  // be bought. Members never see prices.
  // Single sign-on: admins, where the plan includes it or a
  // connection exists (so it can be switched off after a downgrade).
  const sso = data.value?.workspace.sso
  if (isAdmin.value && sso && (sso.available || sso.status !== 'none')) {
    items.push({ label: t('workspace.tabs.sso'), icon: 'i-lucide-key-round', slot: 'sso', value: 'sso' })
  }
  // Audit log: admins of a plan that includes it.
  if (isAdmin.value && data.value?.workspace.auditLog?.available) {
    items.push({ label: t('workspace.tabs.audit'), icon: 'i-lucide-scroll-text', slot: 'audit', value: 'audit' })
  }
  if (isAdmin.value && billingEnabled.value) {
    items.push({ label: t('workspace.tabs.billing'), icon: 'i-lucide-credit-card', slot: 'billing', value: 'billing' })
  }
  return items
})

// With every tab (a Business workspace has eight) the strip is wider than
// the column, and always on a phone: it scrolls sideways without a
// scrollbar and fades the edge that hides tabs. The chosen tab is kept in
// view (deep links such as `?tab=billing` land on a tab that starts off screen).
const tabsRef = useTemplateRef<{ $el?: HTMLElement }>('tabs')
const tabList = computed(() => tabsRef.value?.$el?.querySelector<HTMLElement>('[role="tablist"]') ?? null)
const { fadeClass: tabFadeClass } = useScrollFade(tabList)
watch([activeTab, tabList], async () => {
  await nextTick()
  tabList.value?.querySelector('[role="tab"][data-state="active"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}, { flush: 'post' })

// Badge next to the workspace name: which plan covers it.
const planBadge = computed(() => {
  const plan = data.value?.workspace.plan
  if (!data.value?.workspace.pooled || (plan !== 'team' && plan !== 'business')) return null
  return plan === 'team' ? 'Team' : 'Business'
})
const paymentProblem = computed(() => isPaymentProblem(data.value?.workspace.billing?.status))

// Back from Stripe Checkout (`?billing=success|cancelled`): say so once,
// then drop the query so a reload doesn't repeat it.
tryOnMounted(() => {
  if (route.query.credits === 'success') {
    toast.add({ title: t('credits.purchased'), description: t('credits.purchasedBody'), icon: 'i-lucide-check', color: 'neutral' })
  }
  const outcome = route.query.billing
  if (outcome === 'success') {
    toast.add({ title: t('workspace.billing.checkoutSuccess'), description: t('workspace.billing.checkoutSuccessBody'), icon: 'i-lucide-check', color: 'neutral' })
  } else if (outcome === 'cancelled') {
    toast.add({ title: t('workspace.billing.checkoutCancelled'), icon: 'i-lucide-x', color: 'neutral' })
  }
  // Back from a single sign-on test.
  if (route.query.test === 'activated') toast.add({ title: t('sso.testActivated'), icon: 'i-lucide-check', color: 'neutral' })
  else if (route.query.test === 'ok') toast.add({ title: t('sso.testOk'), icon: 'i-lucide-check', color: 'neutral' })
  if (route.query.billing || route.query.tab || route.query.credits || route.query.test) void router.replace({ query: {} })
})

// Same dialog flow as the home page; just pass our workspaceId so the
// new doc files into this workspace from the start.
const showNewDocDialog = ref(false)
function createDocument() {
  showNewDocDialog.value = true
}
function onDocCreated(docId: string) {
  void router.push(`/d/${docId}`)
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
  const target = deleteTargetDoc.value
  if (!target || !data.value) return
  data.value.documents = data.value.documents.filter(d => d.docId !== target.docId)
  deleteTargetDoc.value = null
}

function onDocDuplicated(newDocId: string) {
  // Send the user into their fresh copy, matches the "file → duplicate"
  // flow in desktop apps, and the workspace view will re-hydrate on the
  // next visit. If the duplicate stayed in this workspace, reloading
  // here would surface it in the list too, but we'd rather the user
  // start editing immediately.
  void router.push(`/d/${newDocId}`)
}

function onDocMoved(newWorkspaceId: string | null) {
  // Doc left this workspace (target is different): drop it from the
  // current list. Same-workspace no-op is impossible here because the
  // row's modal doesn't allow picking the current workspace's option
  // server-side it's a no-op anyway.
  const target = moveTargetDoc.value
  if (!target || !data.value) return
  if (newWorkspaceId !== workspaceId.value) {
    data.value.documents = data.value.documents.filter(
      d => d.docId !== target.docId
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
  void router.replace('/')
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
  void router.replace('/')
}

// Admin vs non-admin see different workspace-level actions. Computed so the
// dropdown content swaps based on role without two separate templates.
const workspaceMenuItems = computed<DropdownMenuItem[][]>(() => {
  if (!data.value) return []
  const items: DropdownMenuItem[] = [
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
      onSelect: () => { void leaveWorkspace() }
    })
  }
  return [items]
})

// Leaving refreshes the caller's workspace list.
const removeMember = useRemoveMember()
async function leaveWorkspace() {
  if (!data.value || myUserId.value == null) return
  try {
    await removeMember.mutateAsync({ workspaceId: data.value.workspace.workspaceId, userId: myUserId.value })
    onLeftWorkspace()
  } catch (e) {
    toast.add({
      title: t('workspace.members.leaveFailed'),
      description: extractError(e).message,
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
         every screen. The folder icon (previously shu) is dropped,
         workspace identity is carried by name + Back, and shu stays
         reserved for AI presence. -->
    <header class="border-b border-default px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
      <div class="flex items-center gap-3 min-w-0">
        <NuxtLink
          to="/"
          class="flex items-center"
          :aria-label="t('common.homeLinkLabel')"
        >
          <CommonWordmark :size="20" />
        </NuxtLink>
        <CommonInstanceBrand
          class="hidden sm:inline-flex"
          :size="20"
          :show-name="false"
        />
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
        v-else-if="ssoRequired"
        class="max-w-3xl mx-auto space-y-10 py-12"
        data-testid="workspace-sso-required"
      >
        <div class="max-w-md mx-auto text-center space-y-4">
          <UIcon
            name="i-lucide-key-round"
            class="size-10 text-muted mx-auto"
          />
          <h1 class="font-serif text-2xl font-normal tracking-tight">
            {{ t('sso.requiredTitle') }}
          </h1>
          <p class="text-sm text-muted">
            {{ t('sso.requiredBody') }}
          </p>
          <UButton
            :to="ssoRequired.loginUrl"
            external
            color="neutral"
            icon="i-lucide-log-in"
            data-testid="workspace-sso-sign-in"
          >
            {{ t('sso.signIn') }}
          </UButton>
        </div>
        <!-- Admins can still repair or switch off the connection. -->
        <WorkspaceSsoPanel
          v-if="ssoRequired.canManageSso"
          :workspace-id="workspaceId"
          @changed="loadWorkspace()"
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
              <!-- Workspace title in the editorial register, Fraunces
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
              <UBadge
                v-if="planBadge"
                size="xs"
                color="neutral"
                variant="outline"
                data-testid="workspace-plan-badge"
              >
                {{ planBadge }}
              </UBadge>
            </div>
            <UAlert
              v-if="isAdmin && paymentProblem"
              class="mt-3"
              color="error"
              variant="subtle"
              icon="i-lucide-alert-triangle"
              :title="t('workspace.billing.paymentProblemTitle')"
              :description="t('workspace.billing.paymentProblemBody')"
              data-testid="workspace-payment-problem"
            />
            <p
              v-if="data.workspace.description"
              class="text-sm text-muted mt-2 whitespace-pre-line"
            >
              {{ data.workspace.description }}
            </p>
            <!-- Gap between workspace description and the member
                 roster: `mt-3` was too tight, the member rows
                 visually merged with the description prose. -->
            <div class="mt-6">
              <WorkspaceMemberAvatars
                :members="data.members"
                @click="openMembers(false)"
              />
            </div>
          </div>
          <!-- Page-level actions only (rename / delete / members); "New
               document" lives in the Documents tab, since a page-level CTA
               would read as the primary action on every tab.
               "Invite people" is the admins' primary page action: a
               visible button, not an entry buried in the members modal. -->
          <div class="flex items-center gap-2 shrink-0">
            <UButton
              v-if="isAdmin"
              icon="i-lucide-user-plus"
              size="sm"
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
                size="sm"
                color="neutral"
                variant="ghost"
                :aria-label="t('workspace.actions')"
              />
            </UDropdownMenu>
          </div>
        </div>

        <!--
          Tabs. variant=link swaps the shu pill for a subtle
          underlined-tab register that fits the editorial chrome.
          color=neutral makes the active underline sumi-950 instead
          of shu: shu stays reserved for AI presence. The label slot
          upgrades the tab text to Fraunces serif so tabs read as
          section titles, not chrome buttons.
        -->
        <UTabs
          ref="tabs"
          v-model="activeTab"
          :items="tabItems"
          variant="link"
          color="neutral"
          :ui="{
            list: `border-b border-default/60 gap-4 sm:gap-6 ${tabFadeClass}`,
            // The underline sits inside the strip: Nuxt UI hangs it one pixel
            // below, which made the strip scroll vertically too.
            indicator: 'bottom-0',
            trigger: 'data-[state=active]:text-default text-muted hover:text-default px-0 py-2.5 shrink-0',
            label: 'font-serif text-base font-normal tracking-tight',
            content: 'mt-6 sm:mt-8'
          }"
        >
          <template #documents>
            <WorkspaceDocumentsTab
              :documents="data.documents"
              :my-role="myRole || 'viewer'"
              :workspace-id="data.workspace.workspaceId"
              :can-create-doc="canCreateDoc"
              @create="createDocument"
              @duplicate-requested="openDocDuplicate"
              @move-requested="openDocMove"
              @delete-requested="openDocDelete"
            />
          </template>

          <template #knowledge>
            <WorkspaceKnowledgePanel
              :workspace-id="data.workspace.workspaceId"
              :my-role="data.workspace.myRole"
              :my-user-id="myUserId ?? null"
            />
          </template>

          <template #settings>
            <!-- Workspace settings: admin-only. Currently houses the
                 default-theme picker; future workspace-wide settings
                 (e.g. retention policy) sit here too. -->
            <WorkspaceSettingsPanel
              :workspace-id="data.workspace.workspaceId"
              :default-theme="data.workspace.defaultTheme"
              @updated="(theme) => { if (data) data.workspace.defaultTheme = theme }"
            />
          </template>
          <template #brand>
            <WorkspaceBrandKitPanel
              :workspace-id="data.workspace.workspaceId"
              :documents="data.documents"
              :default-theme="data.workspace.defaultTheme"
              :locked="data.workspace.brandLocked ?? false"
              @changed="loadWorkspace()"
            />
          </template>
          <template #usage>
            <WorkspaceUsagePanel :workspace-id="data.workspace.workspaceId" />
          </template>
          <template #audit>
            <WorkspaceAuditPanel :workspace-id="data.workspace.workspaceId" />
          </template>
          <template #sso>
            <WorkspaceSsoPanel
              :workspace-id="data.workspace.workspaceId"
              @changed="loadWorkspace()"
            />
          </template>
          <template #billing>
            <WorkspaceBillingPanel
              :workspace-id="data.workspace.workspaceId"
              @changed="loadWorkspace()"
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
      :billing="data.workspace.billing ?? null"
      :guests-available="data.workspace.guests?.available ?? false"
      :sso-active="data.workspace.sso?.status === 'active'"
      @billing-changed="loadWorkspace()"
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
