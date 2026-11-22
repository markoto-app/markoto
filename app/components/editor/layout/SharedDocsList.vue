<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import { useSharedDocuments } from '~/queries/sharedDocuments'
import { docOpenTarget, docPath, openDocInNewTab } from '~/utils/explorer/docLinks'

// The Workspace tab of the editor's left panel for someone who is not a
// member of the document's workspace (a guest, or a visitor of a public
// document): only the documents of this workspace that were shared with
// them, never its folders or its other documents (the server's rule for
// guests, `/api/user/shared-documents`).

const props = defineProps<{
  workspaceId: string
  docId: string
}>()

const { t } = useI18n()
const shared = useSharedDocuments()

const docs = computed(() => (shared.data.value ?? [])
  .filter(d => d.workspaceId === props.workspaceId)
  .sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })))

interface Item extends TreeItem {
  key: string
  docId: string
}

const items = computed<Item[]>(() => docs.value.map(d => ({
  key: d.docId,
  docId: d.docId,
  label: d.title || t('editor.untitled'),
  icon: d.docId === props.docId ? 'i-lucide-file-pen-line' : 'i-lucide-file-text'
})))
const selected = computed(() => items.value.find(i => i.docId === props.docId))

type TreeEvent = CustomEvent<{ originalEvent: Event }>

function onSelect(e: TreeEvent, item: Item) {
  e.preventDefault()
  if (docOpenTarget(e.detail.originalEvent as MouseEvent) === 'new-tab') openDocInNewTab(item.docId)
  else if (item.docId !== props.docId) void navigateTo(docPath(item.docId))
}

function onAuxclick(e: MouseEvent) {
  if (e.button !== 1) return
  const id = (e.target as Element | null)?.closest<HTMLElement>('[data-doc-id]')?.dataset.docId
  if (!id) return
  e.preventDefault()
  openDocInNewTab(id)
}
</script>

<template>
  <div
    class="p-2"
    data-testid="shared-docs"
  >
    <p
      v-if="shared.isLoading.value && items.length === 0"
      class="px-2 py-6 text-center text-sm text-muted"
    >
      {{ t('common.loading') }}
    </p>
    <p
      v-else-if="items.length === 0"
      class="px-2 py-6 text-center text-sm text-muted"
    >
      {{ t('leftPanel.workspace.notMember') }}
    </p>
    <template v-else>
      <p class="px-2 pb-2 text-xs text-muted">
        {{ t('leftPanel.workspace.sharedWithYou') }}
      </p>
      <UTree
        :model-value="selected"
        :items="items"
        :get-key="(item: Item) => item.key"
        :on-select="onSelect"
        :aria-label="t('leftPanel.workspace.sharedWithYou')"
        color="neutral"
        size="sm"
        :ui="{ link: 'data-[selected]:bg-(--explorer-selected-bg) data-[selected]:text-highlighted' }"
        data-testid="shared-docs-tree"
        @auxclick="onAuxclick"
      >
        <template #item-label="{ item }">
          <span
            class="truncate"
            :title="String(item.label)"
            :data-doc-id="(item as Item).docId"
          >{{ item.label }}</span>
        </template>
      </UTree>
    </template>
  </div>
</template>
