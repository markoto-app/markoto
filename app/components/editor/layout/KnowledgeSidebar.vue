<script setup lang="ts">
// The workspace knowledge base in the editor's right sidebar: the same
// upload / list / delete surface as the workspace overview, scoped to the
// document's workspace.
defineProps<{
  workspaceId: string
  role: 'admin' | 'editor' | 'viewer'
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const { user: sessionUser } = useUserSession()
</script>

<template>
  <div
    class="h-full flex flex-col bg-muted"
  >
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-library"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('knowledge.title') }}
        </h3>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        class="mk-panel-close"
        data-testid="panel-close"
        :aria-label="t('common.close')"
        @click="emit('close')"
      />
    </div>
    <div class="flex-1 overflow-y-auto p-3 min-h-0">
      <WorkspaceKnowledgePanel
        :workspace-id="workspaceId"
        :my-role="role"
        :my-user-id="sessionUser?.id ?? null"
        compact
      />
    </div>
  </div>
</template>
