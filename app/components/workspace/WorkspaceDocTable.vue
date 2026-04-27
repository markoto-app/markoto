<script setup lang="ts">
import { languageBadge, resolveLanguageDisplayName } from '~~/shared/languages'

// Doc list for the workspace detail page. Action gates:
//   - Duplicate: any editor or admin (anyone with edit access).
//   - Move: admin OR doc owner (canManage equivalent).
//   - Delete: admin OR doc owner (canManage equivalent).
// Viewers see no action menu. The server re-checks all three rules on
// the underlying endpoints — the UI gates are UX-only.

export interface WorkspaceDoc {
  docId: string
  title: string
  description: string
  language: string
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
  // Current workspaceId — threaded into row actions so the Move modal
  // can preselect "this workspace" and the server's no-op check trips.
  workspaceId: string
}>()

const emit = defineEmits<{
  duplicateRequested: [doc: WorkspaceDoc]
  moveRequested: [doc: WorkspaceDoc]
  deleteRequested: [doc: WorkspaceDoc]
}>()

const { t } = useI18n()

function canEdit() {
  return props.myRole === 'admin' || props.myRole === 'editor'
}
function canManage(doc: WorkspaceDoc) {
  return props.myRole === 'admin' || doc.isOwner
}
function hasAnyAction(doc: WorkspaceDoc) {
  return canEdit() || canManage(doc)
}

function rowMenu(doc: WorkspaceDoc) {
  const items: Array<Record<string, unknown>> = []
  if (canEdit()) {
    items.push({
      label: t('common.duplicate'),
      icon: 'i-lucide-copy',
      onSelect: () => emit('duplicateRequested', doc)
    })
  }
  if (canManage(doc)) {
    items.push({
      label: t('common.move'),
      icon: 'i-lucide-folder-input',
      onSelect: () => emit('moveRequested', doc)
    })
    items.push({
      label: t('common.delete'),
      icon: 'i-lucide-trash-2',
      color: 'error',
      onSelect: () => emit('deleteRequested', doc)
    })
  }
  return [items]
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
        <UIcon
          name="i-lucide-file-text"
          class="size-5 text-muted shrink-0"
        />
        <div class="min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <p class="text-sm font-medium truncate">{{ doc.title || t('workspace.untitledDoc') }}</p>
            <!-- Language badge always shown so members spot the doc's
                 language at a glance regardless of their UI locale.
                 Tooltip carries the full display name for free-text
                 languages where the 4-letter abbreviation is opaque
                 ("SCHW" → "Schwiizerdütsch"). -->
            <UTooltip :text="resolveLanguageDisplayName(doc.language)">
              <UBadge
                size="xs"
                color="neutral"
                variant="outline"
                class="font-mono shrink-0"
              >
                {{ languageBadge(doc.language) }}
              </UBadge>
            </UTooltip>
          </div>
          <p
            v-if="doc.description"
            class="text-xs text-toned truncate"
          >
            {{ doc.description }}
          </p>
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
          v-if="hasAnyAction(doc)"
          :items="rowMenu(doc)"
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
