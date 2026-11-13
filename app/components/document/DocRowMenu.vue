<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { docRowActionGroups, type DocRowAction } from '~/utils/workspace/docRowActions'

// The "…" menu of a document row on the dashboard and the workspace page.
// Which actions show is decided by `docRowActionGroups` (permission
// matrix, unit-tested); the parent owns the modals and reacts to the
// emitted events. Open / Open in new tab are plain links.
//
// `open` is a two-way model so a long-press on the row can open the menu
// too. It must be written in both directions: a one-way `:open` binding
// keeps Reka's menu controlled and closed, so the trigger would do nothing.

const props = defineProps<{
  docId: string
  canEdit: boolean
  canManage: boolean
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  duplicate: []
  move: []
  delete: []
}>()

const { t } = useI18n()

interface DocRowMenuItem extends DropdownMenuItem {
  action: DocRowAction
}

function itemFor(action: DocRowAction): DocRowMenuItem {
  const docUrl = `/d/${props.docId}`
  switch (action) {
    case 'open':
      return { action, label: t('docRow.open'), icon: 'i-lucide-file-text', to: docUrl }
    case 'openNewTab':
      return { action, label: t('docRow.openNewTab'), icon: 'i-lucide-external-link', to: docUrl, target: '_blank' }
    case 'duplicate':
      return { action, label: t('common.duplicate'), icon: 'i-lucide-copy', onSelect: () => emit('duplicate') }
    case 'move':
      return { action, label: t('common.move'), icon: 'i-lucide-folder-input', onSelect: () => emit('move') }
    case 'delete':
      return { action, label: t('common.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: () => emit('delete') }
  }
}

const items = computed<DocRowMenuItem[][]>(() =>
  docRowActionGroups({ canEdit: props.canEdit, canManage: props.canManage })
    .map(group => group.map(itemFor))
)
</script>

<template>
  <UDropdownMenu
    v-model:open="open"
    :items="items"
    :content="{ align: 'end' }"
  >
    <UButton
      icon="i-lucide-more-vertical"
      color="neutral"
      variant="ghost"
      size="xs"
      class="opacity-60 group-hover:opacity-100 transition-opacity"
      :aria-label="t('docRow.actions')"
      data-testid="doc-row-menu"
    />
    <!-- `data-testid` on the item config doesn't reach the DOM, so the
         label carries it. -->
    <template #item-label="{ item }">
      <span :data-testid="`doc-row-action-${item.action}`">{{ item.label }}</span>
    </template>
  </UDropdownMenu>
</template>
