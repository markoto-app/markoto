<script setup lang="ts">
import type { FolderRow } from '~/utils/explorer/model'

// Where the explorer is: root / folder / subfolder. Each segment is a link
// and a drop target; on a phone the path collapses to "... / parent /
// current", the folder tree opens from a button, and "up" goes one level up.

const props = defineProps<{
  path: readonly FolderRow[]
  rootLabel: string
  isMobile: boolean
  folderHref: (folderId: string | null) => string
}>()
const emit = defineEmits<{
  'up': []
  'open-folders': []
}>()
const { t } = useI18n()

interface Crumb { label: string, folderId: string | null | undefined, icon?: string, to?: string }
const crumbs = computed<Crumb[]>(() => {
  const all: Crumb[] = [
    { label: props.rootLabel, folderId: null, icon: 'i-lucide-hard-drive' },
    ...props.path.map(f => ({ label: f.name, folderId: f.folderId }))
  ].map((c, i, list) => ({ ...c, to: i === list.length - 1 || c.folderId === undefined ? undefined : props.folderHref(c.folderId) }))
  return props.isMobile && all.length > 3 ? [{ label: '...', folderId: undefined }, ...all.slice(-2)] : all
})
</script>

<template>
  <div class="flex items-center gap-2 min-w-0">
    <UButton
      class="sm:hidden"
      icon="i-lucide-folder-tree"
      size="xs"
      color="neutral"
      variant="ghost"
      :aria-label="t('explorer.folders')"
      @click="emit('open-folders')"
    />
    <UButton
      v-if="path.length > 0"
      icon="i-lucide-arrow-up"
      size="xs"
      color="neutral"
      variant="ghost"
      :aria-label="t('explorer.up')"
      data-testid="explorer-up"
      @click="emit('up')"
    />
    <UBreadcrumb
      :items="crumbs"
      class="min-w-0"
      :ui="{ link: 'aria-[current=page]:text-highlighted' }"
      data-testid="explorer-breadcrumb"
    >
      <template #item-label="{ item }">
        <ExplorerTreeLabel
          v-if="item.folderId !== undefined"
          :label="String(item.label)"
          :folder-id="item.folderId ?? null"
        />
        <span v-else>{{ item.label }}</span>
      </template>
    </UBreadcrumb>
  </div>
</template>
