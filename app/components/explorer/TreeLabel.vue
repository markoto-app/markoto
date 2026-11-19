<script setup lang="ts">
import { useExplorerDragDrop } from '~/composables/explorer/useExplorerDnd'

// One node label of the folder tree: a drop target for its folder (null =
// the root). It registers on the node's whole row (the tree's link element).

const props = defineProps<{
  label: string
  folderId: string | null
  count?: number
}>()

const root = useTemplateRef<HTMLElement>('root')
const link = computed(() => root.value?.closest<HTMLElement>('[data-slot="link"]') ?? null)
const { over } = useExplorerDragDrop(link, { folderId: () => props.folderId })
watchEffect(() => {
  link.value?.classList.toggle('explorer-drop-over', over.value)
  if (link.value) link.value.dataset.folderId = props.folderId ?? 'root'
})
</script>

<template>
  <span
    ref="root"
    class="flex items-center gap-2 min-w-0"
  >
    <span class="truncate">{{ label }}</span>
    <span
      v-if="count"
      class="font-mono text-[10.5px] text-muted shrink-0"
    >{{ count }}</span>
  </span>
</template>
