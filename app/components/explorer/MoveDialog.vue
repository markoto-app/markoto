<script setup lang="ts">
import { canDropInto, type ExplorerItem, type FolderRow } from '~/utils/explorer/model'
import type { ExplorerScope } from '~/composables/explorer/useExplorerData'
import { useMyWorkspaces } from '~/queries/workspaces'

// "Move to…": the keyboard and touch way to do what dragging does. Pick a
// folder of this scope, or (documents only) another workspace or the
// personal documents. Moving to another workspace changes who can see the
// documents, so it says so.

const props = defineProps<{
  scope: ExplorerScope
  folders: readonly FolderRow[]
  items: readonly ExplorerItem[]
  rootLabel: string
  current: string | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  pick: [target: { folderId: string | null } | { workspaceId: string | null }]
}>()

const { t } = useI18n()
const picked = ref<string | null>(null)
watch(open, (v) => {
  if (v) picked.value = props.current
})
const valid = computed(() => canDropInto(props.folders, props.items, picked.value))

const onlyDocs = computed(() => props.items.length > 0 && props.items.every(i => i.kind === 'doc'))
const mode = ref<'folder' | 'workspace'>('folder')
watch(open, (v) => {
  if (v) mode.value = 'folder'
})
const workspaces = useMyWorkspaces(() => open.value && onlyDocs.value)
const currentWs = computed(() => props.scope.kind === 'workspace' ? props.scope.workspaceId : null)
const workspaceOptions = computed(() => [
  ...(currentWs.value !== null ? [{ label: t('explorer.move.personal'), value: '__personal__' }] : []),
  ...(workspaces.data.value ?? [])
    .filter(w => w.workspaceId !== currentWs.value && (w.role === 'admin' || w.role === 'editor'))
    .map(w => ({ label: w.name, value: w.workspaceId }))
])
const pickedWs = ref<string | undefined>(undefined)
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('explorer.move.title', { n: items.length }, items.length)"
  >
    <template #body>
      <div
        class="space-y-4"
        data-testid="explorer-move-dialog"
      >
        <UTabs
          v-if="onlyDocs && workspaceOptions.length > 0"
          v-model="mode"
          :items="[{ label: t('explorer.move.toFolder'), value: 'folder' }, { label: t('explorer.move.toWorkspace'), value: 'workspace' }]"
          :content="false"
          size="sm"
          color="neutral"
          variant="link"
        />
        <div
          v-if="mode === 'folder'"
          class="max-h-80 overflow-y-auto rounded-md border border-default p-1"
        >
          <ExplorerTree
            :folders="folders"
            :current="picked"
            :root-label="rootLabel"
            picker
            @select="(id) => picked = id"
          />
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <USelect
            v-model="pickedWs"
            :items="workspaceOptions"
            class="w-full"
            :placeholder="t('explorer.move.pickWorkspace')"
          />
          <UAlert
            color="neutral"
            variant="subtle"
            icon="i-lucide-users"
            :description="t('explorer.move.workspaceWarning')"
          />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          color="neutral"
          variant="ghost"
          @click="open = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          v-if="mode === 'folder'"
          color="neutral"
          :disabled="!valid"
          data-testid="explorer-move-confirm"
          @click="emit('pick', { folderId: picked })"
        >
          {{ t('explorer.move.here') }}
        </UButton>
        <UButton
          v-else
          color="neutral"
          :disabled="!pickedWs"
          @click="emit('pick', { workspaceId: pickedWs === '__personal__' ? null : pickedWs ?? null })"
        >
          {{ t('explorer.move.toWorkspaceConfirm') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
