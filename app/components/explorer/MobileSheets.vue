<script setup lang="ts">
import type { ContextMenuItem } from '@nuxt/ui'
import type { FolderRow } from '~/utils/explorer/model'

// The explorer on a phone: the folder tree in a bottom sheet, and the
// actions of a long-pressed item in another (the context menu of a desktop).

defineProps<{
  folders: readonly FolderRow[]
  current: string | null
  rootLabel: string
  /** The long-pressed item's name and its actions; null = closed. */
  item: { label: string, actions: ContextMenuItem[] } | null
}>()
const foldersOpen = defineModel<boolean>('foldersOpen', { required: true })
const emit = defineEmits<{
  'open-folder': [folderId: string | null]
  'close-item': []
}>()

const { t } = useI18n()

function run(entry: ContextMenuItem) {
  emit('close-item')
  entry.onSelect?.(new Event('select'))
}
</script>

<template>
  <ClientOnly>
    <CommonBottomSheet
      v-if="foldersOpen"
      v-model="foldersOpen"
      :title="t('explorer.folders')"
    >
      <ExplorerTree
        :folders="folders"
        :current="current"
        :root-label="rootLabel"
        picker
        @select="(id) => { foldersOpen = false; emit('open-folder', id) }"
      />
    </CommonBottomSheet>
    <CommonBottomSheet
      v-if="item"
      :model-value="true"
      :title="item.label"
      snap-height="auto"
      @update:model-value="(v: boolean) => { if (!v) emit('close-item') }"
    >
      <div class="flex flex-col py-1">
        <UButton
          v-for="(entry, i) in item.actions"
          :key="i"
          :icon="entry.icon"
          :color="entry.color === 'error' ? 'error' : 'neutral'"
          variant="ghost"
          class="justify-start"
          @click="run(entry)"
        >
          {{ entry.label }}
        </UButton>
      </div>
    </CommonBottomSheet>
  </ClientOnly>
</template>
