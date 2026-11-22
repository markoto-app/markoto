<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import { useExplorerData, type DocListParams, type ExplorerScope } from '~/composables/explorer/useExplorerData'
import { buildDocTree, folderIdsAbove, type DocTreeEntry } from '~/utils/explorer/docTree'
import { docOpenTarget, docPath, openDocInNewTab } from '~/utils/explorer/docLinks'

// The Workspace tab of the editor's left panel for a workspace member (or,
// for a document outside any workspace, the person's own documents): the
// folders and documents of the scope as one tree, the current document
// marked. Same data as the explorer (`useExplorerData`: the same routes,
// permissions and change counter, so someone else's new document appears
// within the explorer's polling interval). Read-only: opening only, the
// explorer itself is one link away.

const props = defineProps<{
  scope: ExplorerScope
  docId: string
}>()

const { t } = useI18n()

// Every document of the scope, by title (pages of 100, "Show more").
const params = ref<DocListParams>({ folder: 'all', sort: 'title', dir: 'asc', q: '' })
const data = useExplorerData(toRef(props, 'scope'), params)

const folders = computed(() => data.folders.data.value ?? [])
const tree = computed(() => buildDocTree(folders.value, data.docRows.value))
const loading = computed(() => (data.docs.isLoading.value || data.folders.isLoading.value) && data.docRows.value.length === 0 && folders.value.length === 0)
const failed = computed(() => data.docs.status.value === 'error' && data.docRows.value.length === 0)

interface Item extends TreeItem {
  key: string
  docId?: string
  children?: Item[]
}

function toItem(entry: DocTreeEntry): Item {
  if (entry.kind === 'folder') {
    return {
      key: `f:${entry.folder.folderId}`,
      label: entry.folder.name,
      icon: 'i-lucide-folder',
      // An empty folder still expands (to show it is empty), like the explorer's.
      children: entry.children.map(toItem)
    }
  }
  return {
    key: `d:${entry.doc.docId}`,
    docId: entry.doc.docId,
    label: entry.doc.title || t('editor.untitled'),
    icon: entry.doc.docId === props.docId ? 'i-lucide-file-pen-line' : 'i-lucide-file-text'
  }
}

const items = computed<Item[]>(() => tree.value.map(toItem))

const current = computed(() => data.docRows.value.find(d => d.docId === props.docId) ?? null)
const selected = computed(() => {
  const key = `d:${props.docId}`
  const find = (list: Item[]): Item | undefined => {
    for (const item of list) {
      if (item.key === key) return item
      const inner = item.children ? find(item.children) : undefined
      if (inner) return inner
    }
    return undefined
  }
  return find(items.value)
})

// Reveal the current document: load further pages until it is among them
// (a large workspace lists it far down, by title), expand the folders
// around it and scroll it into view once.
const expanded = ref<string[]>([])
watch(() => [current.value?.folderId ?? null, folders.value] as const, ([folderId]) => {
  const above = folderIdsAbove(folders.value, folderId).map(id => `f:${id}`)
  expanded.value = [...new Set([...expanded.value, ...above])]
}, { immediate: true })

/** Pages the panel loads by itself while looking for the current document. */
const REVEAL_MAX_PAGES = 20
let revealPages = 0
watch(() => [current.value, data.docs.hasNextPage.value, data.docs.isLoading.value] as const, ([doc, more, busy]) => {
  if (doc || !more || busy || revealPages >= REVEAL_MAX_PAGES) return
  revealPages++
  void data.docs.loadNextPage()
}, { immediate: true })

const root = useTemplateRef<HTMLElement>('root')
let revealed = false
watch(() => [selected.value, expanded.value] as const, async ([item]) => {
  if (revealed || !item) return
  await nextTick()
  const row = root.value?.querySelector(`[data-doc-id="${CSS.escape(props.docId)}"]`)?.closest('[role="treeitem"]')
  if (!row) return
  revealed = true
  row.scrollIntoView({ block: 'nearest' })
}, { immediate: true, flush: 'post' })

type TreeEvent = CustomEvent<{ originalEvent: Event }>

function onSelect(e: TreeEvent, item: Item) {
  e.preventDefault()
  const original = e.detail.originalEvent
  if (!item.docId) {
    // Enter / Space on a folder opens or closes it (a click already does).
    if (original.type === 'keydown') {
      expanded.value = expanded.value.includes(item.key)
        ? expanded.value.filter(k => k !== item.key)
        : [...expanded.value, item.key]
    }
    return
  }
  const target = docOpenTarget(original as MouseEvent | KeyboardEvent)
  if (target === 'new-tab') openDocInNewTab(item.docId)
  else if (item.docId !== props.docId) void navigateTo(docPath(item.docId))
}

// Middle click: the document in a new tab, as a link would.
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
    ref="root"
    class="p-2"
    data-testid="workspace-docs"
  >
    <p
      v-if="loading"
      class="px-2 py-6 text-center text-sm text-muted"
    >
      {{ t('common.loading') }}
    </p>
    <div
      v-else-if="failed"
      class="flex flex-col items-center gap-2 px-4 py-8 text-center"
    >
      <p class="text-sm text-muted">
        {{ t('leftPanel.workspace.loadFailed') }}
      </p>
      <UButton
        color="neutral"
        variant="soft"
        size="xs"
        :label="t('leftPanel.workspace.retry')"
        @click="data.refresh()"
      />
    </div>
    <p
      v-else-if="items.length === 0"
      class="px-2 py-6 text-center text-sm text-muted"
      data-testid="workspace-docs-empty"
    >
      {{ t('leftPanel.workspace.empty') }}
    </p>
    <template v-else>
      <UTree
        v-model:expanded="expanded"
        :model-value="selected"
        :items="items"
        :get-key="(item: Item) => item.key"
        :on-select="onSelect"
        :aria-label="t('leftPanel.tabs.workspace')"
        color="neutral"
        size="sm"
        :ui="{ link: 'data-[selected]:bg-(--explorer-selected-bg) data-[selected]:text-highlighted' }"
        data-testid="workspace-docs-tree"
        @auxclick="onAuxclick"
      >
        <template #item-trailing="{ item, expanded: isOpen }">
          <UIcon
            v-if="(item as Item).children"
            :name="isOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            :data-chevron="isOpen ? 'down' : 'right'"
            class="size-4 shrink-0 text-dimmed"
          />
        </template>
        <template #item-label="{ item }">
          <span
            class="truncate"
            :title="String(item.label)"
            :data-doc-id="(item as Item).docId"
            :aria-current="(item as Item).docId === docId ? 'page' : undefined"
          >{{ item.label }}</span>
        </template>
      </UTree>
      <div
        v-if="data.docs.hasNextPage.value"
        class="px-2 pt-2"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          block
          :loading="data.docs.isLoading.value"
          :label="t('leftPanel.workspace.showMore')"
          data-testid="workspace-docs-more"
          @click="data.docs.loadNextPage()"
        />
      </div>
    </template>
  </div>
</template>
