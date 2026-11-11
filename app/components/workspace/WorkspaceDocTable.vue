<script setup lang="ts">
import { languageBadge, resolveLanguageDisplayName } from '~~/shared/languages'

import { workspaceDocPermissions } from '~/utils/workspace/docRowActions'
import type { ApiResponse } from '~/utils/api/client'

// Doc list for the workspace detail page. Every member gets a row menu
// (Open / Open in new tab); the rest follows `docRowActionGroups`:
//   - Duplicate: any editor or admin (anyone with edit access).
//   - Move / Delete: admin OR doc owner (canManageDoc).
// The server re-checks all rules on the underlying endpoints — the UI
// gates are UX-only.

export type WorkspaceDoc = ApiResponse<'/api/workspaces/:wsId', 'get'>['documents'][number]

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

function permsFor(doc: WorkspaceDoc) {
  return workspaceDocPermissions(props.myRole, doc.isOwner)
}

// Long-press to open the row's actions menu — discoverable on touch
// where the 3-dot button is a small target. Per-row open state keyed
// on docId so only the long-pressed row's menu opens.
const openMenuDocId = ref<string | null>(null)
function onRowLongPress(doc: WorkspaceDoc) {
  openMenuDocId.value = doc.docId
}
function setMenuOpen(doc: WorkspaceDoc, open: boolean) {
  if (open) openMenuDocId.value = doc.docId
  else if (openMenuDocId.value === doc.docId) openMenuDocId.value = null
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="doc in documents"
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
          <p class="text-xs text-muted">
            <CommonTimeAgo :ts="doc.lastActive" />
          </p>
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
        <span class="hidden sm:inline text-xs text-muted">{{ doc.wordCount || 0 }} words</span>
        <DocumentDocRowMenu
          :doc-id="doc.docId"
          :can-edit="permsFor(doc).canEdit"
          :can-manage="permsFor(doc).canManage"
          :open="openMenuDocId === doc.docId"
          @update:open="(v: boolean) => setMenuOpen(doc, v)"
          @duplicate="emit('duplicateRequested', doc)"
          @move="emit('moveRequested', doc)"
          @delete="emit('deleteRequested', doc)"
        />
      </div>
    </div>
  </div>
</template>
