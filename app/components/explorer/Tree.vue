<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import { buildFolderTree, folderPathOf, type FolderNode, type FolderRow } from '~/utils/explorer/model'

// The folder tree beside the list (and in the folder picker of "Move to").
// UTree gives the ARIA tree and its keyboard (arrows, Home / End, Right
// expands, Left collapses). Every node is a drop target; right-clicking a
// node asks the explorer for that folder's menu.

const props = defineProps<{
  folders: readonly FolderRow[]
  /** The open (or picked) folder; null = the root. */
  current: string | null
  rootLabel: string
  /** Picker mode (Move to): no drag and drop, no context menu. */
  picker?: boolean
}>()

const emit = defineEmits<{
  select: [folderId: string | null]
  contextmenu: [folderId: string | null, event: MouseEvent]
}>()

interface Node extends TreeItem {
  key: string
  folderId: string | null
  count?: number
  children?: Node[]
}

function toNode(n: FolderNode): Node {
  return {
    key: n.folder.folderId,
    folderId: n.folder.folderId,
    label: n.folder.name,
    count: n.folder.docCount,
    icon: 'i-lucide-folder',
    ...(n.children.length > 0 ? { children: n.children.map(toNode) } : {})
  }
}

const items = computed<Node[]>(() => [{
  key: 'root',
  folderId: null,
  label: props.rootLabel,
  icon: 'i-lucide-hard-drive',
  defaultExpanded: true,
  children: buildFolderTree(props.folders).map(toNode)
}])

// The open folder's ancestors stay expanded, so a deep link shows where it is.
const expanded = ref<string[]>(['root'])
watch(() => [props.current, props.folders] as const, () => {
  const path = folderPathOf(props.folders, props.current).map(f => f.folderId)
  expanded.value = [...new Set([...expanded.value, 'root', ...path.slice(0, -1)])]
}, { immediate: true })

const selected = computed(() => {
  const find = (list: Node[]): Node | undefined => {
    for (const n of list) {
      if (n.folderId === props.current) return n
      const inner = n.children ? find(n.children) : undefined
      if (inner) return inner
    }
    return undefined
  }
  return find(items.value)
})

function onContextmenu(event: MouseEvent) {
  if (props.picker) return
  const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-folder-id]')
  if (!el) return
  const id = el.dataset.folderId
  emit('contextmenu', id === 'root' || id === undefined ? null : id, event)
}
</script>

<template>
  <UTree
    v-model:expanded="expanded"
    :model-value="selected"
    :items="items"
    :get-key="(item: Node) => item.key"
    color="neutral"
    size="sm"
    :ui="{ link: 'data-[selected]:bg-(--explorer-selected-bg)' }"
    data-testid="explorer-tree"
    @update:model-value="(v: unknown) => { const n = v as Node | undefined; if (n) emit('select', n.folderId) }"
    @contextmenu="onContextmenu"
  >
    <template #item-label="{ item }">
      <ExplorerTreeLabel
        v-if="!picker"
        :label="String(item.label)"
        :folder-id="(item as Node).folderId"
      />
      <span
        v-else
        class="truncate"
        :data-folder-id="(item as Node).folderId ?? 'root'"
      >{{ item.label }}</span>
    </template>
  </UTree>
</template>
