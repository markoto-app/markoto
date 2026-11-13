<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'
import { useAcceptInvite } from '~/queries/workspaces'

// Dashboard "Invitations" section: open workspace invitations addressed
// to the signed-in user's account email (`GET /api/user/invites`).
// Accepting creates the membership (the mutation refreshes the workspace
// list) and emits `accepted`; declining just removes the card. Renders
// nothing when there are no invitations.

export type WorkspaceInviteItem = ApiResponse<'/api/user/invites', 'get'>[number]

const props = defineProps<{
  invites: WorkspaceInviteItem[]
}>()

const emit = defineEmits<{
  accepted: [workspaceId: string]
  removed: [inviteId: string]
}>()

const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()
const busy = ref<string | null>(null)
// Refreshes the workspace list before resolving.
const acceptInvite = useAcceptInvite()

function roleLabel(role: WorkspaceInviteItem['role']): string {
  return t(`workspace.roles.${role}`)
}

async function act(invite: WorkspaceInviteItem, action: 'accept' | 'decline'): Promise<void> {
  if (busy.value) return
  busy.value = invite.inviteId
  try {
    if (action === 'accept') {
      const res = await acceptInvite.mutateAsync(invite.inviteId)
      emit('removed', invite.inviteId)
      toast.add({
        title: t('workspace.invites.accepted', { name: res.workspaceName ?? invite.workspaceName }),
        icon: 'i-lucide-check',
        color: 'neutral'
      })
      emit('accepted', res.workspaceId)
    } else {
      await apiFetch('/api/user/invites/:inviteId/decline', { method: 'post', path: { inviteId: invite.inviteId } })
      emit('removed', invite.inviteId)
    }
  } catch (e) {
    showError(action === 'accept' ? 'workspace.invites.acceptFailed' : 'workspace.invites.declineFailed', e)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <ul
    v-if="props.invites.length > 0"
    class="space-y-2"
    data-testid="workspace-invite-list"
  >
    <li
      v-for="invite in props.invites"
      :key="invite.inviteId"
      class="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-default"
      :data-testid="`workspace-invite-${invite.inviteId}`"
    >
      <div class="flex items-start gap-3 min-w-0 flex-1">
        <div class="size-9 rounded-md bg-elevated flex items-center justify-center shrink-0">
          <UIcon
            name="i-lucide-mail-plus"
            class="size-5 text-muted"
          />
        </div>
        <div class="min-w-0">
          <p class="font-serif text-base font-normal tracking-tight truncate">
            {{ invite.workspaceName }}
          </p>
          <p class="text-xs text-muted">
            {{ invite.invitedByName
              ? t('workspace.invites.invitedBy', { name: invite.invitedByName, role: roleLabel(invite.role) })
              : t('workspace.invites.invitedAs', { role: roleLabel(invite.role) }) }}
          </p>
          <p
            v-if="invite.workspacePlan"
            class="text-xs text-muted mt-0.5"
            :data-testid="`workspace-invite-plan-${invite.inviteId}`"
          >
            {{ t('workspace.invites.planIncluded', { name: invite.workspaceName, plan: invite.workspacePlan === 'team' ? 'Team' : 'Business' }) }}
          </p>
        </div>
      </div>
      <div class="flex gap-2 shrink-0">
        <UButton
          color="neutral"
          size="sm"
          :loading="busy === invite.inviteId"
          :disabled="busy !== null && busy !== invite.inviteId"
          :data-testid="`workspace-invite-accept-${invite.inviteId}`"
          @click="act(invite, 'accept')"
        >
          {{ t('workspace.invites.accept') }}
        </UButton>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="busy !== null"
          :data-testid="`workspace-invite-decline-${invite.inviteId}`"
          @click="act(invite, 'decline')"
        >
          {{ t('workspace.invites.decline') }}
        </UButton>
      </div>
    </li>
  </ul>
</template>
