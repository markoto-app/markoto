<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { DOC_LIST_SORTS, type DocListSort } from '~~/shared/api/explorer'

// The explorer's toolbar: search (this folder, or every folder), sort and
// order, the phone's "Select" switch and the "New" menu.

defineProps<{
  sort: DocListSort
  dir: 'asc' | 'desc'
  query: string
  everywhere: boolean
  canWrite: boolean
  isMobile: boolean
  selectMode: boolean
}>()
const search = defineModel<string>('search', { required: true })
const emit = defineEmits<{
  'sort': [sort: DocListSort]
  'dir': [dir: 'asc' | 'desc']
  'everywhere': [on: boolean]
  'toggle-select': []
  'new-document': []
  'new-folder': []
  'import': []
}>()

const { t } = useI18n()
const sortItems = computed(() => DOC_LIST_SORTS.map(s => ({ label: t(`explorer.sort.${s}`), value: s })))
const newMenu = computed<DropdownMenuItem[][]>(() => [[
  { label: t('explorer.action.newDocument'), icon: 'i-lucide-file-plus', onSelect: () => emit('new-document') },
  { label: t('explorer.action.newFolder'), icon: 'i-lucide-folder-plus', onSelect: () => emit('new-folder') },
  { label: t('explorer.action.import'), icon: 'i-lucide-upload', onSelect: () => emit('import') }
]])
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <UInput
      v-model="search"
      color="neutral"
      icon="i-lucide-search"
      size="sm"
      class="w-full sm:w-64"
      :placeholder="t('explorer.searchPlaceholder')"
      :aria-label="t('explorer.searchPlaceholder')"
      data-testid="explorer-search"
    />
    <UCheckbox
      v-if="query"
      :model-value="everywhere"
      :label="t('explorer.searchEverywhere')"
      size="sm"
      @update:model-value="(v: boolean | 'indeterminate') => emit('everywhere', v === true)"
    />
    <USelect
      :model-value="sort"
      :items="sortItems"
      size="sm"
      class="w-40"
      :aria-label="t('explorer.sortBy')"
      data-testid="explorer-sort"
      @update:model-value="(v: unknown) => emit('sort', v as DocListSort)"
    />
    <UButton
      :icon="dir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
      size="sm"
      color="neutral"
      variant="ghost"
      :aria-label="t(`explorer.sortDirection.${dir}`)"
      data-testid="explorer-sort-direction"
      @click="emit('dir', dir === 'asc' ? 'desc' : 'asc')"
    />
    <div class="flex-1" />
    <UButton
      v-if="isMobile"
      size="sm"
      color="neutral"
      variant="ghost"
      :icon="selectMode ? 'i-lucide-x' : 'i-lucide-check-square'"
      @click="emit('toggle-select')"
    >
      {{ selectMode ? t('explorer.done') : t('explorer.select') }}
    </UButton>
    <UDropdownMenu
      v-if="canWrite"
      :items="newMenu"
    >
      <UButton
        icon="i-lucide-plus"
        size="sm"
        color="neutral"
        data-testid="explorer-new"
      >
        {{ t('explorer.new') }}
      </UButton>
    </UDropdownMenu>
  </div>
</template>
