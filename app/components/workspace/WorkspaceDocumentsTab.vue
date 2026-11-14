<script setup lang="ts">
import type { WorkspaceDoc } from '~/components/workspace/WorkspaceDocTable.vue'

// The workspace page's Documents tab: the list (or the empty state) and,
// for members who may write, "New document".
defineProps<{
  documents: WorkspaceDoc[]
  myRole: 'admin' | 'editor' | 'viewer'
  workspaceId: string
  canCreateDoc: boolean
}>()
const emit = defineEmits<{
  'create': []
  'duplicate-requested': [doc: WorkspaceDoc]
  'move-requested': [doc: WorkspaceDoc]
  'delete-requested': [doc: WorkspaceDoc]
}>()
const { t } = useI18n()
</script>

<template>
  <!-- Same header pattern as the Knowledge tab: icon +
       Fraunces serif title + JetBrains Mono micro-count,
       primary action right-aligned. The
       page-level "New document" button moved here so the
       CTA only fires when the user is actually looking at
       the documents list. -->
  <section class="space-y-3">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2.5 min-w-0">
        <UIcon
          name="i-lucide-file-text"
          class="text-toned size-5 shrink-0"
        />
        <h2 class="font-serif text-2xl font-normal tracking-tight">
          {{ t('workspace.tabs.documents') }}
        </h2>
        <span
          v-if="documents.length > 0"
          class="font-mono text-[10.5px] tracking-[0.04em] text-muted"
        >{{ documents.length }}</span>
      </div>
      <UButton
        v-if="canCreateDoc"
        icon="i-lucide-plus"
        size="sm"
        color="neutral"
        data-testid="workspace-new-document"
        @click="emit('create')"
      >
        {{ t('workspace.newDocument') }}
      </UButton>
    </div>
    <div
      v-if="documents.length > 0"
      class="pt-2"
    >
      <WorkspaceDocTable
        :documents="documents"
        :my-role="myRole"
        :workspace-id="workspaceId"
        @duplicate-requested="doc => emit('duplicate-requested', doc)"
        @move-requested="doc => emit('move-requested', doc)"
        @delete-requested="doc => emit('delete-requested', doc)"
      />
    </div>
    <div
      v-else
      class="text-center py-12 border border-dashed border-default rounded-lg bg-default"
    >
      <UIcon
        name="i-lucide-file-plus"
        class="size-6 text-muted mx-auto mb-2"
      />
      <p class="font-serif text-lg font-normal tracking-tight">
        {{ t('workspace.empty') }}
      </p>
      <!-- The "start by creating your first document" hint belongs to the
           empty state only. -->
      <p
        class="text-xs text-muted mt-1"
        data-testid="workspace-documents-empty-hint"
      >
        {{ canCreateDoc ? t('workspace.emptyDescription') : t('workspace.emptyDescriptionViewer') }}
      </p>
    </div>
  </section>
</template>
