<script setup lang="ts">
import type { WorkspaceMember } from './WorkspaceMemberAvatars.vue'
import type { WorkspaceSeatBilling } from '~/utils/billing/workspaceBilling'
import { formatPrice } from '~/utils/billing/pricing'
import { isCurrency } from '~~/shared/config/pricing'
import type { ApiResponse } from '~/utils/api/client'
import { useQueryCache } from '@pinia/colada'
import { useChangeMemberRole, useRemoveMember } from '~/queries/workspaces'
import { planPricesQuery } from '~/queries/billing'

// Members management modal. Single modal for admin + member views; the role
// gates feature visibility:
//   - Admin: add new, change role, remove any (incl. self if not last admin)
//   - Editor / Viewer: read-only list + "leave workspace" on own row
//
// Invite-by-email is the only way in — no typeahead search, so the user
// base can't be enumerated. The server records a PENDING invitation and
// answers the same way whether or not the address has an account; the
// person joins only after accepting (dashboard, or the invitation email).
// Admins see the open invitations below the roster and can revoke them.

type MemberRole = 'admin' | 'editor' | 'viewer'
// Guests see only documents shared with them; no workspace role.
type InviteRole = MemberRole | 'guest'

const props = defineProps<{
  workspaceId: string
  workspaceName: string
  members: WorkspaceMember[]
  myRole: MemberRole
  // The workspace's plan allows guests (admins only).
  guestsAvailable?: boolean
  myUserId: number
  // Opened from the workspace header's "Invite people" button: focus
  // the email field so the admin can type straight away.
  focusInvite?: boolean
  // Team / Business subscription (admins only): paid seats and seats
  // in use (members + open invitations). Null = no seat limit.
  billing?: WorkspaceSeatBilling | null
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  updated: [members: WorkspaceMember[]]
  leave: []
  // Seats or seats in use changed (an invite, a revoke, a bought seat).
  billingChanged: []
}>()

const { t, locale } = useI18n()
const toast = useToast()

const localMembers = ref<WorkspaceMember[]>([])
const newEmail = ref('')
const newRole = ref<InviteRole>('editor')
const adding = ref(false)
const rowBusy = ref<number | null>(null)

const isAdmin = computed(() => props.myRole === 'admin')
// Both refresh the caller's workspace list (their own role or membership
// may be what changed).
const queryCache = useQueryCache()
const changeMemberRole = useChangeMemberRole()
const removeMemberMutation = useRemoveMember()

type PendingInvite = ApiResponse<'/api/workspaces/:wsId/invites', 'get'>[number]
const invites = ref<PendingInvite[]>([])
const inviteBusy = ref<string | null>(null)
const { showError, extractError } = useErrorHandler()

async function loadInvites(): Promise<void> {
  if (!isAdmin.value) {
    invites.value = []
    return
  }
  try {
    invites.value = await apiFetch('/api/workspaces/:wsId/invites', { path: { wsId: props.workspaceId } })
  } catch {
    invites.value = []
  }
}

watch(open, (v) => {
  if (v) {
    localMembers.value = [...props.members]
    newEmail.value = ''
    newRole.value = 'editor'
    void loadInvites()
  }
})

function fmtDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(locale.value, { month: 'short', day: 'numeric' })
}

async function revokeInvite(invite: PendingInvite) {
  inviteBusy.value = invite.inviteId
  try {
    await apiFetch('/api/workspaces/:wsId/invites/:inviteId', { method: 'delete', path: { wsId: props.workspaceId, inviteId: invite.inviteId } })
    invites.value = invites.value.filter(i => i.inviteId !== invite.inviteId)
    emit('billingChanged')
  } catch (e) {
    showError('workspace.members.revokeFailed', e)
  } finally {
    inviteBusy.value = null
  }
}

const adminCount = computed(() => localMembers.value.filter(m => m.role === 'admin').length)

function isSoleAdmin(m: WorkspaceMember) {
  return m.role === 'admin' && adminCount.value <= 1
}

function roleLabel(role: WorkspaceMember['role']) {
  if (role === 'admin') return t('workspace.roles.admin')
  if (role === 'editor') return t('workspace.roles.editor')
  if (role === 'guest') return t('workspace.roles.guest')
  return t('workspace.roles.viewer')
}

// "This adds a seat": an invite into a workspace whose paid seats
// are all taken is refused (409 billing/seats-full); the admin confirms
// and the invite is sent again with `addSeat: true`, which buys one seat.
const seatConfirm = ref<{ email: string, seats: number } | null>(null)
const seatPrice = ref<string | null>(null)
const seatsLabel = computed(() => props.billing
  ? t('workspace.billing.seatCounter', { used: props.billing.seatsUsed, seats: props.billing.seats })
  : null)

async function loadSeatPrice() {
  const billing = props.billing
  seatPrice.value = null
  if (!billing || !isCurrency(billing.currency)) return
  try {
    // The cached price table when the billing tab already loaded it.
    const { data: prices } = await queryCache.refresh(queryCache.ensure(planPricesQuery({ api: apiFetch })))
    if (!prices) return
    // The workspace's plan arrives as a plain string; only per-seat plans have a seat price.
    const row = billing.plan === 'team' || billing.plan === 'business' ? prices.prices[billing.currency]?.[billing.plan] : undefined
    if (!row) return
    const amount = formatPrice(billing.interval === 'year' ? row.year : row.month, billing.currency.toUpperCase(), locale.value)
    seatPrice.value = t(billing.interval === 'year' ? 'workspace.billing.pricePerSeatYear' : 'workspace.billing.pricePerSeatMonth', { price: amount })
  } catch {
    seatPrice.value = null
  }
}

async function addMember(addSeat = false) {
  const email = (addSeat && seatConfirm.value ? seatConfirm.value.email : newEmail.value).trim()
  if (!email) return
  adding.value = true
  try {
    await apiFetch('/api/workspaces/:wsId/members', {
      method: 'post',
      path: { wsId: props.workspaceId },
      body: { email, role: newRole.value, ...(addSeat ? { addSeat: true } : {}) }
    })
    seatConfirm.value = null
    emit('billingChanged')
    toast.add({
      title: t('workspace.members.invitedToast'),
      description: t('workspace.members.invitedToastDescription', { email }),
      icon: 'i-lucide-mail-check',
      color: 'neutral'
    })
    newEmail.value = ''
    newRole.value = 'editor'
    await loadInvites()
  } catch (e) {
    if (!addSeat && extractError(e).code === 'billing/seats-full' && props.billing) {
      seatConfirm.value = { email, seats: props.billing.seats }
      void loadSeatPrice()
    } else {
      showError('workspace.members.addFailed', e)
    }
  } finally {
    adding.value = false
  }
}

async function changeRole(member: WorkspaceMember, role: 'admin' | 'editor' | 'viewer') {
  if (member.role === role) return
  rowBusy.value = member.userId
  try {
    await changeMemberRole.mutateAsync({ workspaceId: props.workspaceId, userId: member.userId, role })
    localMembers.value = localMembers.value.map(m => m.userId === member.userId ? { ...m, role } : m)
    emit('updated', localMembers.value)
  } catch (e) {
    showError('workspace.members.roleChangeFailed', e)
  } finally {
    rowBusy.value = null
  }
}

async function removeMember(member: WorkspaceMember) {
  rowBusy.value = member.userId
  try {
    await removeMemberMutation.mutateAsync({ workspaceId: props.workspaceId, userId: member.userId })
    const wasMe = member.userId === props.myUserId
    localMembers.value = localMembers.value.filter(m => m.userId !== member.userId)
    emit('updated', localMembers.value)
    if (wasMe) {
      // Leaving the workspace — close modal + let the parent route away.
      open.value = false
      emit('leave')
    }
  } catch (e) {
    showError('workspace.members.removeFailed', e)
  } finally {
    rowBusy.value = null
  }
}

type WorkspaceRole = 'admin' | 'editor' | 'viewer'

const inviteRoleItems = computed(() => [
  { label: t('workspace.roles.admin'), value: 'admin' },
  { label: t('workspace.roles.editor'), value: 'editor' },
  { label: t('workspace.roles.viewer'), value: 'viewer' },
  ...(props.guestsAvailable ? [{ label: t('workspace.roles.guest'), value: 'guest' }] : [])
])

function roleItems(currentRole: WorkspaceRole, member: WorkspaceMember) {
  return [
    (['admin', 'editor', 'viewer'] as WorkspaceRole[]).map(role => ({
      label: roleLabel(role) + (currentRole === role ? ' ✓' : ''),
      onSelect: () => changeRole(member, role),
      disabled: currentRole === role
    }))
  ]
}

// Non-admin rendering uses a disabled look for the role chip — no dropdown.
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('workspace.members.title', { name: workspaceName })"
    :description="isAdmin ? t('workspace.members.adminDescription') : t('workspace.members.memberDescription')"
    :ui="{ content: 'sm:max-w-lg' }"
    :content="focusInvite ? initialFocus('workspace-invite-email') : undefined"
  >
    <template #body>
      <div class="space-y-4">
        <!-- Member list -->
        <ul class="divide-y divide-default border border-default rounded-lg overflow-hidden">
          <li
            v-for="m in localMembers"
            :key="m.userId"
            class="flex items-center gap-3 p-3"
            :data-testid="`workspace-member-row-${m.userId}`"
          >
            <CommonUserAvatar
              :seed="avatarSeedFor({ id: m.userId })"
              :size="32"
            />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium truncate">
                {{ m.name }}
                <span
                  v-if="m.userId === myUserId"
                  class="text-xs text-muted font-normal"
                >{{ t('workspace.members.you') }}</span>
              </p>
              <p class="text-xs text-muted truncate">
                {{ m.email || m.login || '' }}
              </p>
            </div>

            <!-- Role chip: dropdown for admin, disabled badge otherwise -->
            <UDropdownMenu
              v-if="isAdmin && m.role !== 'guest'"
              :items="roleItems(m.role as WorkspaceRole, m)"
              :content="{ align: 'end' }"
            >
              <UButton
                color="neutral"
                variant="subtle"
                size="xs"
                :loading="rowBusy === m.userId"
                :disabled="isSoleAdmin(m)"
                trailing-icon="i-lucide-chevron-down"
                data-testid="workspace-member-role"
              >
                {{ roleLabel(m.role) }}
              </UButton>
            </UDropdownMenu>
            <UBadge
              v-else
              size="xs"
              color="neutral"
              variant="subtle"
              :data-testid="m.role === 'guest' ? 'workspace-member-guest-badge' : undefined"
            >
              {{ roleLabel(m.role) }}
            </UBadge>

            <!-- Remove button: admin can remove anyone (except sole admin); member can leave self -->
            <UTooltip
              v-if="(isAdmin && !isSoleAdmin(m)) || (m.userId === myUserId && !isSoleAdmin(m))"
              :text="m.userId === myUserId ? t('workspace.members.leave') : t('workspace.members.remove')"
            >
              <UButton
                :icon="m.userId === myUserId ? 'i-lucide-log-out' : 'i-lucide-x'"
                color="neutral"
                variant="ghost"
                size="xs"
                :loading="rowBusy === m.userId"
                @click="removeMember(m)"
              />
            </UTooltip>
          </li>
        </ul>

        <!-- Admin-only: open invitations (the address typed, never
             account data). -->
        <div
          v-if="isAdmin && invites.length > 0"
          class="space-y-2"
          data-testid="workspace-pending-invites"
        >
          <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
            {{ t('workspace.members.pendingTitle') }}
          </h3>
          <ul class="divide-y divide-default border border-default rounded-lg overflow-hidden">
            <li
              v-for="invite in invites"
              :key="invite.inviteId"
              class="flex items-center gap-3 p-3"
              :data-testid="`workspace-pending-invite-${invite.email}`"
            >
              <div class="size-8 rounded-full flex items-center justify-center bg-elevated shrink-0">
                <UIcon
                  name="i-lucide-mail"
                  class="size-4 text-muted"
                />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm truncate">
                  {{ invite.email }}
                </p>
                <p class="font-mono text-[10.5px] lowercase tracking-wide text-muted">
                  {{ t('workspace.members.pendingExpires', { date: fmtDate(invite.expiresAt) }) }}
                </p>
              </div>
              <UBadge
                size="xs"
                color="neutral"
                variant="subtle"
              >
                {{ roleLabel(invite.role) }}
              </UBadge>
              <UTooltip :text="t('workspace.members.revoke')">
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :aria-label="t('workspace.members.revoke')"
                  :loading="inviteBusy === invite.inviteId"
                  :data-testid="`workspace-revoke-invite-${invite.email}`"
                  @click="revokeInvite(invite)"
                />
              </UTooltip>
            </li>
          </ul>
        </div>

        <!-- Admin-only: invite a new member -->
        <div
          v-if="isAdmin"
          class="space-y-2 pt-2 border-t border-default"
        >
          <p class="text-sm font-medium">
            {{ t('workspace.members.addTitle') }}
          </p>
          <p class="text-xs text-muted">
            {{ t('workspace.members.addHint') }}
          </p>
          <p
            v-if="seatsLabel"
            class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
            data-testid="workspace-seat-counter"
          >
            {{ seatsLabel }}
          </p>
          <div class="flex gap-2">
            <UInput
              id="workspace-invite-email"
              v-model="newEmail"
              type="email"
              :placeholder="t('workspace.members.emailPlaceholder')"
              class="flex-1"
              :ui="{ base: 'w-full' }"
              data-testid="workspace-invite-email"
              @keydown.enter="addMember()"
            />
            <USelectMenu
              v-model="newRole"
              :items="inviteRoleItems"
              value-key="value"
              class="w-32"
              data-testid="workspace-invite-role"
            />
            <UButton
              :loading="adding"
              :disabled="!newEmail.trim()"
              icon="i-lucide-plus"
              data-testid="workspace-invite-submit"
              @click="addMember()"
            >
              {{ t('workspace.members.add') }}
            </UButton>
          </div>
          <p
            v-if="newRole === 'guest'"
            class="text-xs text-muted"
            data-testid="workspace-invite-guest-hint"
          >
            {{ t('workspace.members.guestHint') }}
          </p>
          <div
            v-if="seatConfirm"
            class="rounded-md border border-default bg-elevated p-3 space-y-2"
            data-testid="workspace-add-seat-confirm"
          >
            <p class="text-sm">
              {{ t('workspace.billing.addSeatTitle', { seats: seatConfirm.seats }) }}
            </p>
            <p class="text-xs text-muted">
              {{ t('workspace.billing.addSeatBody', { email: seatConfirm.email }) }}
              <span v-if="seatPrice"> {{ seatPrice }}</span>
            </p>
            <div class="flex justify-end gap-2">
              <UButton
                variant="ghost"
                color="neutral"
                size="sm"
                @click="seatConfirm = null"
              >
                {{ t('common.cancel') }}
              </UButton>
              <UButton
                color="neutral"
                size="sm"
                :loading="adding"
                data-testid="workspace-add-seat-submit"
                @click="addMember(true)"
              >
                {{ t('workspace.billing.addSeatConfirm') }}
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          variant="ghost"
          @click="open = false"
        >
          {{ t('common.close') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
