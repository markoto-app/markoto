<script setup lang="ts">
// Doc list for the workspace detail page. Delete action is gated by role:
//   - Admin: can delete any doc in the workspace.
//   - Editor: can delete only docs they created (isOwner).
//   - Viewer: cannot delete anything.
// The gating here is purely UX (hide the menu); the server enforces the
// same rule on DELETE /api/docs/:docId (canManageDoc).

export interface WorkspaceDoc {
  docId: string
  title: string
  accessMode: 'private' | 'open-edit' | 'open-view' | 'password-protected'
  wordCount: number | null
  sizeBytes: number | null
  lastActive: string | number | Date
  ownerId: number | null
  isOwner: boolean
}

const props = defineProps<{
  documents: WorkspaceDoc[]
  myRole: 'admin' | 'editor' | 'viewer'
}>()

const emit = defineEmits<{
  deleteRequested: [doc: WorkspaceDoc]
}>()

const { t } = useI18n()

function canDelete(doc: WorkspaceDoc) {
  return props.myRole === 'admin' || doc.isOwner
}

function formatDate(value: string | number | Date) {
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="doc in documents"
      :key="doc.docId"
      class="group flex items-center gap-3 p-3 rounded-lg border border-default hover:bg-muted/50 transition-colors"
    >
      <NuxtLink
        :to="`/d/${doc.docId}`"
        class="flex items-center gap-3 min-w-0 flex-1"
      >
        <UIcon name="i-lucide-file-text" class="size-5 text-muted shrink-0" />
        <div class="min-w-0">
          <p class="text-sm font-medium truncate">{{ doc.title || t('workspace.untitledDoc') }}</p>
          <p class="text-xs text-muted">{{ formatDate(doc.lastActive) }}</p>
        </div>
      </NuxtLink>
      <div class="flex items-center gap-2 shrink-0">
        <UBadge
          v-if="doc.accessMode !== 'private'"
          size="xs"
          color="neutral"
          variant="subtle"
        >
          {{
            doc.accessMode === 'open-edit' ? t('share.openEdit')
              : doc.accessMode === 'open-view' ? t('share.openView')
                : t('share.passwordProtected')
          }}
        </UBadge>
        <span class="text-xs text-muted">{{ doc.wordCount || 0 }} words</span>
        <UDropdownMenu
          v-if="canDelete(doc)"
          :items="[
            {
              label: t('common.delete'),
              icon: 'i-lucide-trash-2',
              color: 'error',
              onSelect: () => emit('deleteRequested', doc)
            }
          ]"
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
</template>
