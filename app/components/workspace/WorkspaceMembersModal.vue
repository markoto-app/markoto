<script setup lang="ts">
import type { WorkspaceMember } from './WorkspaceMemberAvatars.vue'

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

const props = defineProps<{
  workspaceId: string
  workspaceName: string
  members: WorkspaceMember[]
  myRole: MemberRole
  myUserId: number
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  updated: [members: WorkspaceMember[]]
  leave: []
}>()

const { t } = useI18n()
const toast = useToast()

const localMembers = ref<WorkspaceMember[]>([])
const newEmail = ref('')
const newRole = ref<'admin' | 'editor' | 'viewer'>('editor')
const adding = ref(false)
const rowBusy = ref<number | null>(null)

const isAdmin = computed(() => props.myRole === 'admin')

interface PendingInvite {
  inviteId: string
  email: string
  role: MemberRole
  invitedByName: string | null
  createdAt: string
  expiresAt: string
}
const invites = ref<PendingInvite[]>([])
const inviteBusy = ref<string | null>(null)
const { showError } = useErrorHandler()

async function loadInvites(): Promise<void> {
  if (!isAdmin.value) {
    invites.value = []
    return
  }
  try {
    invites.value = await $fetch<PendingInvite[]>(`/api/workspaces/${props.workspaceId}/invites`)
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
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function revokeInvite(invite: PendingInvite) {
  inviteBusy.value = invite.inviteId
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/invites/${invite.inviteId}`, { method: 'DELETE' })
    invites.value = invites.value.filter(i => i.inviteId !== invite.inviteId)
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
  return t('workspace.roles.viewer')
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('')
}

async function addMember() {
  const email = newEmail.value.trim()
  if (!email) return
  adding.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/members`, {
      method: 'POST',
      body: { email, role: newRole.value }
    })
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
    showError('workspace.members.addFailed', e)
  } finally {
    adding.value = false
  }
}

async function changeRole(member: WorkspaceMember, role: 'admin' | 'editor' | 'viewer') {
  if (member.role === role) return
  rowBusy.value = member.userId
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/members/${member.userId}`, {
      method: 'PATCH',
      body: { role }
    })
    localMembers.value = localMembers.value.map(m => m.userId === member.userId ? { ...m, role } : m)
    emit('updated', localMembers.value)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('workspace.members.roleChangeFailed'),
      description: err?.data?.message || err?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    rowBusy.value = null
  }
}

async function removeMember(member: WorkspaceMember) {
  rowBusy.value = member.userId
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}/members/${member.userId}`, {
      method: 'DELETE'
    })
    const wasMe = member.userId === props.myUserId
    localMembers.value = localMembers.value.filter(m => m.userId !== member.userId)
    emit('updated', localMembers.value)
    if (wasMe) {
      // Leaving the workspace — close modal + let the parent route away.
      open.value = false
      emit('leave')
    }
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('workspace.members.removeFailed'),
      description: err?.data?.message || err?.message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    rowBusy.value = null
  }
}

type WorkspaceRole = 'admin' | 'editor' | 'viewer'

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
  >
    <template #body>
      <div class="space-y-4">
        <!-- Member list -->
        <ul class="divide-y divide-default border border-default rounded-lg overflow-hidden">
          <li
            v-for="m in localMembers"
            :key="m.userId"
            class="flex items-center gap-3 p-3"
          >
            <UAvatar
              v-if="m.avatarUrl"
              :src="m.avatarUrl"
              :alt="m.name"
              size="sm"
              referrerpolicy="no-referrer"
            />
            <div
              v-else
              class="size-8 rounded-full flex items-center justify-center text-[11px] font-semibold text-white bg-primary/70"
            >
              {{ initials(m.name) }}
            </div>
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
              v-if="isAdmin"
              :items="roleItems(m.role, m)"
              :content="{ align: 'end' }"
            >
              <UButton
                color="neutral"
                variant="subtle"
                size="xs"
                :loading="rowBusy === m.userId"
                :disabled="isSoleAdmin(m)"
                trailing-icon="i-lucide-chevron-down"
              >
                {{ roleLabel(m.role) }}
              </UButton>
            </UDropdownMenu>
            <UBadge
              v-else
              size="xs"
              color="neutral"
              variant="subtle"
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
          <div class="flex gap-2">
            <UInput
              v-model="newEmail"
              type="email"
              :placeholder="t('workspace.members.emailPlaceholder')"
              class="flex-1"
              :ui="{ base: 'w-full' }"
              data-testid="workspace-invite-email"
              @keydown.enter="addMember"
            />
            <USelectMenu
              v-model="newRole"
              :items="[
                { label: t('workspace.roles.admin'), value: 'admin' },
                { label: t('workspace.roles.editor'), value: 'editor' },
                { label: t('workspace.roles.viewer'), value: 'viewer' }
              ]"
              value-key="value"
              class="w-32"
            />
            <UButton
              :loading="adding"
              :disabled="!newEmail.trim()"
              icon="i-lucide-plus"
              data-testid="workspace-invite-submit"
              @click="addMember"
            >
              {{ t('workspace.members.add') }}
            </UButton>
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
