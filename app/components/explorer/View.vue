<script setup lang="ts">
import {
  canDropInto,
  docItem,
  explorerPermissions,
  folderItem,
  folderPathOf,
  freeFolderName,
  type ExplorerItem,
  type MenuAction,
  type WorkspaceRoleName
} from '~/utils/explorer/model'
import { clickSelect, EMPTY_SELECTION, pruneSelection, type SelectionState } from '~/utils/explorer/selection'
import { useExplorerData, type DocListParams, type ExplorerScope } from '~/composables/explorer/useExplorerData'
import { EXPLORER_STALE_TOAST_ID, useExplorerActions } from '~/composables/explorer/useExplorerActions'
import { useExplorerKeyboard } from '~/composables/explorer/useExplorerKeyboard'
import { useExplorerMenu } from '~/composables/explorer/useExplorerMenu'
import { useExplorerColumns } from '~/composables/explorer/useExplorerColumns'
import { useExplorerGrid } from '~/composables/explorer/useExplorerGrid'
import { useExplorerLongPress } from '~/composables/explorer/useExplorerLongPress'
import { explorerDndKey } from '~/composables/explorer/useExplorerDnd'
import { useExplorerDropMonitor, useExplorerImport } from '~/composables/explorer/useExplorerImportDrop'
import { DOC_LIST_SORTS, type DocListSort } from '~~/shared/api/explorer'

// The documents explorer of a workspace or of the user's personal documents,
// modelled on a desktop file manager: folder tree, breadcrumbs, a virtualised
// list with click / Ctrl / Shift selection, keyboard navigation, inline
// rename (F2, or a slow second click), context menus, drag and drop onto
// folders, tree nodes and breadcrumbs, cut and paste, undo for moves, bulk
// delete, import by drop. The open folder lives in the URL (`/w/:id/f/:folderId`,
// `/f/:folderId`), sort, order and search in the query, so back / forward
// and shared links work. On a phone: tap opens, long-press shows the item's
// actions, "Select" switches to checkbox selection, folders in a bottom sheet.

const props = defineProps<{
  scope: ExplorerScope
  /** The person's role in the workspace, or `owner` for their personal documents. */
  access: WorkspaceRoleName | 'owner'
  /** The open folder (from the route); null = the root. */
  folderId: string | null
  rootLabel: string
  /** URL of a folder of this scope (null = the root). */
  folderHref: (folderId: string | null) => string
}>()

const emit = defineEmits<{
  'new-document': [folderId: string | null]
}>()

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const { copy } = useCopyText()
const isMobile = useMediaQuery('(max-width: 639px)')

const perms = computed(() => explorerPermissions(props.access))
const scopeRef = computed(() => props.scope)

// ---------- view state in the URL query ----------
const sort = computed<DocListSort>(() => {
  const s = route.query.sort
  return typeof s === 'string' && (DOC_LIST_SORTS as readonly string[]).includes(s) ? s as DocListSort : 'updated'
})
const dir = computed<'asc' | 'desc'>(() => {
  const d = route.query.dir
  if (d === 'asc' || d === 'desc') return d
  return sort.value === 'title' ? 'asc' : 'desc'
})
const searchText = ref(typeof route.query.q === 'string' ? route.query.q : '')
const q = computed(() => typeof route.query.q === 'string' ? route.query.q.trim() : '')
const searchEverywhere = computed(() => route.query.in === 'all')

function setQuery(patch: Record<string, string | undefined>) {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...route.query, ...patch })) {
    if (typeof v === 'string' && v !== '') next[k] = v
  }
  void router.replace({ query: next })
}
const pushSearch = useDebounceFn((value: string) => setQuery({ q: value.trim() || undefined }), 300)
watch(searchText, v => void pushSearch(v))

const params = computed<DocListParams>(() => ({
  folder: q.value && searchEverywhere.value ? 'all' : props.folderId ?? 'root',
  sort: sort.value,
  dir: dir.value,
  q: q.value
}))

// ---------- data ----------
const announcement = ref('')
function announce(text: string) {
  announcement.value = ''
  void nextTick(() => {
    announcement.value = text
  })
}
const data = useExplorerData(scopeRef, params)
const actions = useExplorerActions({ scope: scopeRef, afterChange: data.afterChange, announce })

const folders = computed(() => data.folders.data.value ?? [])
const currentPath = computed(() => folderPathOf(folders.value, props.folderId))

// A folder that disappeared (deleted or moved away by someone else) sends the
// person to the root with a note, instead of an empty page.
watch(() => props.folderId !== null && data.folders.status.value === 'success' && currentPath.value.length === 0, (missing) => {
  if (!missing) return
  toast.add({ id: EXPLORER_STALE_TOAST_ID, title: t('explorer.folderGone'), icon: 'i-lucide-refresh-cw', color: 'neutral' })
  void router.replace(props.folderHref(null))
})

const items = computed<ExplorerItem[]>(() => {
  const subfolders = q.value
    ? []
    : folders.value.filter(f => f.parentId === props.folderId).sort((a, b) => a.name.localeCompare(b.name, locale.value, { numeric: true, sensitivity: 'base' }))
  return [...subfolders.map(folderItem), ...data.docRows.value.map(docItem)]
})
const keys = computed(() => items.value.map(i => i.key))
const byKey = computed(() => new Map(items.value.map(i => [i.key, i])))
const totalCount = computed(() => (q.value ? 0 : items.value.filter(i => i.kind === 'folder').length) + data.total.value)

// ---------- selection and rename ----------
const selection = shallowRef<SelectionState>(EMPTY_SELECTION)
const selectedItems = computed(() => [...selection.value.selected].map(k => byKey.value.get(k)).filter((i): i is ExplorerItem => !!i))
const selectMode = ref(false)
const renamingKey = ref<string | null>(null)
// Another person's change refetches the list: keep selection, focus and a
// rename in progress for whatever is still there.
watch(keys, (k) => {
  selection.value = pruneSelection(selection.value, k)
  if (renamingKey.value !== null && !k.includes(renamingKey.value)) renamingKey.value = null
})
watch(() => [props.folderId, q.value], () => {
  selection.value = EMPTY_SELECTION
  renamingKey.value = null
})
function selectOnly(key: string) {
  selection.value = { selected: new Set([key]), anchor: key, focus: key }
}

function canChange(item: ExplorerItem): boolean {
  return item.kind === 'folder' ? perms.value.canWrite : perms.value.canWrite || item.doc.isOwner
}
let slowClickTimer: ReturnType<typeof setTimeout> | null = null
function cancelSlowClick() {
  if (slowClickTimer) clearTimeout(slowClickTimer)
  slowClickTimer = null
}
function startRename(key: string | null) {
  cancelSlowClick()
  const item = key ? byKey.value.get(key) : undefined
  if (item && canChange(item)) renamingKey.value = item.key
}
async function commitRename(item: ExplorerItem, name: string) {
  renamingKey.value = null
  await actions.renameItem(item, name)
  focusRow(item.key)
}
function cancelRename(key: string) {
  renamingKey.value = null
  focusRow(key)
}

// ---------- navigation ----------
// Opened from the keyboard: once the folder's list has loaded (even empty),
// the focus goes into it (else it drops to the page and needs a Tab back).
let focusAfterOpen = false
watch([keys, data.docs.isLoading], ([k, loading]) => {
  if (!focusAfterOpen || loading) return
  focusAfterOpen = false
  void nextTick(() => {
    if (!k[0]) return scrollEl.value?.parentElement?.focus()
    selectOnly(k[0])
    focusRow(k[0])
  })
})
function openFolder(folderId: string | null) {
  const query: Record<string, string> = {}
  for (const n of ['sort', 'dir']) if (typeof route.query[n] === 'string') query[n] = route.query[n]
  void router.push({ path: props.folderHref(folderId), query })
}
function openItem(item: ExplorerItem, newTab = false) {
  const href = item.kind === 'folder' ? props.folderHref(item.id) : `/d/${item.id}`
  if (newTab) window.open(href, '_blank', 'noopener')
  else if (item.kind === 'folder') openFolder(item.id)
  else void router.push(href)
}
function goUp() {
  if (props.folderId !== null) openFolder(currentPath.value.at(-2)?.folderId ?? null)
}

// ---------- rows ----------
const tableRef = useTemplateRef<{ $el?: HTMLElement }>('table')
const scrollEl = computed(() => tableRef.value?.$el ?? null)
const { focusRow, rowHeight: ROW_HEIGHT } = useExplorerGrid({
  scrollEl,
  keys,
  focus: () => selection.value.focus,
  totalCount: () => totalCount.value,
  label: () => t('explorer.listLabel', { name: currentPath.value.at(-1)?.name ?? props.rootLabel }),
  hasNextPage: () => data.docs.hasNextPage.value,
  isLoading: () => data.docs.isLoading.value,
  loadNextPage: () => void data.docs.loadNextPage()
})

function onRowSelect(e: Event, row: { original: ExplorerItem }) {
  const item = row.original
  const mouse = e as MouseEvent
  cancelSlowClick()
  if (renamingKey.value === item.key) return
  if (e.type === 'keydown' || (isMobile.value && !selectMode.value)) {
    focusAfterOpen = e.type === 'keydown' && item.kind === 'folder'
    openItem(item)
    return
  }
  if (selectMode.value) {
    selection.value = clickSelect(selection.value, keys.value, item.key, { ctrl: true })
    return
  }
  const wasSole = selection.value.selected.size === 1 && selection.value.selected.has(item.key)
  const ctrl = mouse.ctrlKey || mouse.metaKey
  selection.value = clickSelect(selection.value, keys.value, item.key, { ctrl, shift: mouse.shiftKey })
  // A second, slow click on the name of the only selected item renames it.
  const onName = !!(mouse.target as HTMLElement | null)?.closest('[data-testid="explorer-item-name"]')
  if (wasSole && !ctrl && !mouse.shiftKey && onName) {
    if (slowClickTimer) clearTimeout(slowClickTimer)
    slowClickTimer = setTimeout(() => startRename(item.key), 600)
  }
}
function onDblclick(e: MouseEvent) {
  if (slowClickTimer) clearTimeout(slowClickTimer)
  slowClickTimer = null
  const key = (e.target as HTMLElement | null)?.closest<HTMLElement>('tr[data-key]')?.dataset.key
  const item = key ? byKey.value.get(key) : undefined
  if (item && renamingKey.value !== item.key) openItem(item)
}

// ---------- menus and actions ----------
const menuTargets = shallowRef<ExplorerItem[]>([])
// Kept across page changes (the personal folders are separate routes, which
// mount a new explorer): cut in one folder, paste in another.
const cut = useState<{ scope: string, items: ExplorerItem[] } | null>('explorer-cut', () => null)
const scopeKey = computed(() => props.scope.kind === 'workspace' ? `ws:${props.scope.workspaceId}` : 'personal')
const canPaste = computed(() => cut.value !== null && cut.value.scope === scopeKey.value && cut.value.items.length > 0)

let rowMenuOpened = false
function onRowContextmenu(_e: Event, row: { original: ExplorerItem }) {
  const key = row.original.key
  if (!selection.value.selected.has(key)) selection.value = clickSelect(selection.value, keys.value, key)
  menuTargets.value = selectedItems.value
  rowMenuOpened = true
}
function onPaneContextmenu() {
  // The row handler ran first for a click on a row; anything else is the empty space.
  if (!rowMenuOpened) {
    selection.value = EMPTY_SELECTION
    menuTargets.value = []
  }
  rowMenuOpened = false
}
function onTreeContextmenu(folderId: string | null) {
  const folder = folderId ? folders.value.find(f => f.folderId === folderId) : undefined
  menuTargets.value = folder ? [folderItem(folder)] : []
}

function itemUrl(item: ExplorerItem): string {
  return `${window.location.origin}${item.kind === 'doc' ? `/d/${item.id}` : props.folderHref(item.id)}`
}
const ACTIONS: Record<MenuAction, (targets: readonly ExplorerItem[], into: string | null) => void> = {
  open: ([first]) => first && openItem(first),
  openNewTab: ([first]) => first && openItem(first, true),
  rename: ([first]) => first && startRename(first.key),
  moveTo: targets => openMoveDialog(targets),
  cut: targets => cutItems(targets),
  duplicate: ([first]) => {
    if (first?.kind === 'doc') duplicateTarget.value = first
  },
  copyLink: ([first]) => first && copy(itemUrl(first)),
  copyLinks: targets => copy(targets.filter(i => i.kind === 'doc').map(itemUrl).join('\n')),
  share: ([first]) => {
    if (first?.kind === 'doc') void router.push({ path: `/d/${first.id}`, query: { share: '1' } })
  },
  delete: targets => openDeleteDialog(targets),
  newDocument: (_t, into) => emit('new-document', into),
  newFolder: (_t, into) => void newFolder(into),
  import: (_t, into) => openImport(into),
  paste: () => void pasteInto(props.folderId)
}
function runAction(action: MenuAction, targets: readonly ExplorerItem[]) {
  const first = targets[0]
  ACTIONS[action](targets, first?.kind === 'folder' ? first.id : props.folderId)
}
const menu = useExplorerMenu({
  perms,
  canPaste,
  isMobile,
  sort,
  dir,
  setSort: (s, d) => setQuery({ ...(s ? { sort: s, dir: undefined } : {}), ...(d ? { dir: d } : {}) }),
  run: runAction
})
const contextItems = computed(() => menu.contextMenu(menuTargets.value))
const selectionMenu = computed(() => menu.menuItems(selectedItems.value))

// ---------- create, cut / paste, move, delete, duplicate ----------
/** A folder's size column: its documents, else its subfolders, else "empty". */
function folderSize(folder: { folderId: string, docCount: number }): string {
  if (folder.docCount > 0) return t('explorer.items', { n: folder.docCount }, folder.docCount)
  const sub = folders.value.filter(f => f.parentId === folder.folderId).length
  return sub > 0 ? t('explorer.subfolders', { n: sub }, sub) : t('explorer.items', { n: 0 }, 0)
}
function folderName(folderId: string | null): string {
  return folderId === null ? props.rootLabel : folders.value.find(f => f.folderId === folderId)?.name ?? props.rootLabel
}
async function newFolder(parentId: string | null) {
  const created = await actions.createFolder(freeFolderName(folders.value, parentId, t('explorer.newFolderName')), parentId)
  if (!created) return
  if (parentId !== props.folderId) openFolder(parentId)
  const key = `f:${created.folderId}`
  await until(() => byKey.value.has(key)).toBe(true, { timeout: 5000 }).catch(() => {})
  selectOnly(key)
  startRename(key)
}
function cutItems(targets: readonly ExplorerItem[]) {
  const movable = targets.filter(canChange)
  if (movable.length === 0) return
  cut.value = { scope: scopeKey.value, items: movable }
  announce(t('explorer.announce.cut', { n: movable.length }, movable.length))
}
async function pasteInto(folderId: string | null) {
  if (!canPaste.value || !cut.value) return
  const moving = cut.value.items
  if (!canDropInto(folders.value, moving, folderId)) {
    toast.add({ title: t('explorer.cannotMoveHere'), icon: 'i-lucide-ban', color: 'neutral' })
    return
  }
  cut.value = null
  await actions.moveItems(moving, folderId, folderName(folderId))
}

const moveTargets = shallowRef<ExplorerItem[]>([])
const moveOpen = ref(false)
function openMoveDialog(targets: readonly ExplorerItem[]) {
  moveTargets.value = [...targets]
  moveOpen.value = true
}
async function onMovePicked(target: { folderId: string | null } | { workspaceId: string | null }) {
  moveOpen.value = false
  if ('folderId' in target) await actions.moveItems(moveTargets.value, target.folderId, folderName(target.folderId))
  else await actions.moveToWorkspace(moveTargets.value, target.workspaceId)
}

const deleteTargets = shallowRef<ExplorerItem[]>([])
const deleteOpen = ref(false)
function openDeleteDialog(targets: readonly ExplorerItem[]) {
  if (targets.length === 0) return
  deleteTargets.value = [...targets]
  deleteOpen.value = true
}
async function onDeleteConfirmed() {
  const targets = deleteTargets.value
  const next = keys.value[keys.value.indexOf(targets.at(-1)?.key ?? '') + 1] ?? null
  deleteOpen.value = false
  await actions.deleteItems(targets)
  // Focus goes to the row after the deleted ones, as in a file manager.
  if (next && byKey.value.has(next)) {
    selectOnly(next)
    focusRow(next)
  }
}

const duplicateTarget = shallowRef<ExplorerItem | null>(null)
const duplicateOpen = computed({
  get: () => duplicateTarget.value !== null,
  set: (v) => {
    if (!v) duplicateTarget.value = null
  }
})
function onDuplicated() {
  duplicateTarget.value = null
  void data.afterChange()
}

// ---------- import ----------
const importer = useExplorerImport({ canWrite: () => perms.value.canWrite, currentFolder: () => props.folderId })
const { openImport } = importer
const { open: importOpen, folder: importFolder, files: importFiles, dragOver: fileDragOver } = importer

// ---------- drag and drop between items ----------
function itemsFor(keyList: readonly string[]): ExplorerItem[] {
  return keyList.map(k => byKey.value.get(k)).filter((i): i is ExplorerItem => !!i)
}
provide(explorerDndKey, {
  dragKeysFor: (key) => {
    // Dragging an item outside the selection drags only that item (it becomes the selection).
    if (!selection.value.selected.has(key)) selection.value = clickSelect(selection.value, keys.value, key)
    const all = [...selection.value.selected]
    return itemsFor(all).every(canChange) ? all : []
  },
  canDrop: (keyList, folderId) => canDropInto(folders.value, itemsFor(keyList), folderId),
  spring: (folderId) => {
    if (folderId !== props.folderId) openFolder(folderId)
  }
})
useExplorerDropMonitor(scrollEl, (dragged, folderId) => void actions.moveItems(itemsFor(dragged), folderId, folderName(folderId)))

// ---------- keyboard ----------
const { onKeydown } = useExplorerKeyboard({
  selection,
  keys,
  items,
  byKey,
  selectedItems,
  isRenaming: () => renamingKey.value !== null,
  canWrite: () => perms.value.canWrite,
  focusRow,
  open: (item) => {
    focusAfterOpen = item.kind === 'folder'
    openItem(item)
  },
  goUp,
  rename: startRename,
  beforeKey: cancelSlowClick,
  remove: openDeleteDialog,
  cut: cutItems,
  paste: () => void pasteInto(props.folderId),
  undo: () => void actions.undoLastMove(),
  newFolder: () => void newFolder(props.folderId),
  clearCut: () => {
    cut.value = null
  }
})

// ---------- table ----------
const columns = useExplorerColumns({
  selectMode,
  isMobile,
  isSelected: key => selection.value.selected.has(key),
  toggle: (key) => {
    selection.value = clickSelect(selection.value, keys.value, key, { ctrl: true })
  }
})

// ---------- breadcrumbs and phone ----------
const foldersSheetOpen = ref(false)
const { longPressTarget, onLongPress } = useExplorerLongPress({ isMobile, find: key => byKey.value.get(key), selectOnly })
const sheetItem = computed(() => longPressTarget.value
  // No "Cut" on a phone: there is no Paste to go with it there ("Move to..." does the job).
  ? { label: longPressTarget.value.label, actions: menu.menuItems([longPressTarget.value]).flat().filter(a => a.label !== t('explorer.action.cut')) }
  : null)
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  selection.value = EMPTY_SELECTION
}

defineExpose({ refresh: data.refresh })
</script>

<template>
  <section
    class="flex gap-6 min-h-0"
    data-testid="explorer"
  >
    <nav
      class="hidden sm:block w-56 shrink-0 max-h-[70vh] overflow-y-auto"
      :aria-label="t('explorer.treeLabel')"
    >
      <UContextMenu
        :items="contextItems"
        :disabled="isMobile"
      >
        <div>
          <ExplorerTree
            :folders="folders"
            :current="folderId"
            :root-label="rootLabel"
            @select="openFolder"
            @contextmenu="onTreeContextmenu"
          />
        </div>
      </UContextMenu>
    </nav>

    <div class="flex-1 min-w-0 space-y-3">
      <ExplorerBreadcrumbs
        :path="currentPath"
        :root-label="rootLabel"
        :is-mobile="isMobile"
        :folder-href="folderHref"
        @up="goUp"
        @open-folders="foldersSheetOpen = true"
      />

      <ExplorerToolbar
        v-model:search="searchText"
        :sort="sort"
        :dir="dir"
        :query="q"
        :everywhere="searchEverywhere"
        :can-write="perms.canWrite"
        :is-mobile="isMobile"
        :select-mode="selectMode"
        @sort="(s) => setQuery({ sort: s, dir: undefined })"
        @dir="(d) => setQuery({ dir: d })"
        @everywhere="(on) => setQuery({ in: on ? 'all' : undefined })"
        @toggle-select="toggleSelectMode"
        @new-document="emit('new-document', folderId)"
        @new-folder="newFolder(folderId)"
        @import="openImport(folderId)"
      />

      <!-- Always laid out (invisible when empty): selecting must not move the rows under the pointer. -->
      <ExplorerSelectionBar
        :class="selectedItems.length === 0 ? 'invisible' : ''"
        :aria-hidden="selectedItems.length === 0 ? 'true' : undefined"
        :count="selectedItems.length"
        :actions="selectionMenu"
        @clear="selection = EMPTY_SELECTION"
      />

      <!-- Right-click on a row: its menu; on empty space: New, Paste, Sort. -->
      <UContextMenu
        :items="contextItems"
        :disabled="isMobile"
      >
        <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- delegates the rows' keyboard, double click and file drops; the rows are the grid's interactive elements -->
        <div
          v-long-press="onLongPress"
          :tabindex="items.length === 0 ? 0 : undefined"
          class="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-default"
          :class="fileDragOver ? 'ring-2 ring-default' : ''"
          @contextmenu="onPaneContextmenu"
          @keydown="onKeydown"
          @dblclick="onDblclick"
          @dragover="importer.onDragover"
          @dragleave="fileDragOver = false"
          @drop="importer.onDrop"
        >
          <UTable
            ref="table"
            :data="items"
            :columns="columns"
            :get-row-id="(row: ExplorerItem) => row.key"
            :loading="data.docs.isLoading.value && items.length === 0"
            :virtualize="{ estimateSize: ROW_HEIGHT, overscan: 12 }"
            sticky
            class="h-[min(70vh,calc(100vh-18rem))] min-h-64"
            :ui="{ tr: 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-default', td: 'py-2' }"
            :on-select="onRowSelect"
            :on-contextmenu="onRowContextmenu"
            data-testid="explorer-list"
          >
            <template #name-cell="{ row }">
              <ExplorerRowName
                :item="row.original"
                :selected="selection.selected.has(row.original.key)"
                :focused="selection.focus === row.original.key"
                :renaming="renamingKey === row.original.key"
                :row-index="row.index"
                :draggable="!isMobile && renamingKey !== row.original.key"
                @rename-commit="(name: string) => commitRename(row.original, name)"
                @rename-cancel="cancelRename(row.original.key)"
              />
            </template>
            <template #owner-cell="{ row }">
              <span
                v-if="row.original.kind === 'doc'"
                class="truncate block"
              >{{ row.original.doc.isOwner ? t('explorer.you') : row.original.doc.ownerName ?? '' }}</span>
            </template>
            <template #updated-cell="{ row }">
              <CommonTimeAgo :ts="row.original.kind === 'doc' ? row.original.doc.updatedAt : row.original.folder.updatedAt" />
            </template>
            <template #words-cell="{ row }">
              <span v-if="row.original.kind === 'doc'">{{ t('docRow.words', { n: row.original.doc.wordCount }) }}</span>
              <span v-else>{{ folderSize(row.original.folder) }}</span>
            </template>
            <template #empty>
              <div
                class="py-12 text-center space-y-1"
                data-testid="explorer-empty"
              >
                <UIcon
                  :name="q ? 'i-lucide-search-x' : 'i-lucide-folder-open'"
                  class="size-6 text-muted mx-auto"
                />
                <p class="font-serif text-lg">
                  {{ q ? t('explorer.noResults') : t('explorer.emptyFolder') }}
                </p>
                <p
                  v-if="!q && perms.canWrite"
                  class="text-xs text-muted"
                >
                  {{ t('explorer.emptyHint') }}
                </p>
              </div>
            </template>
          </UTable>
          <div
            v-if="fileDragOver"
            class="absolute inset-0 flex items-center justify-center bg-default/80 rounded-md pointer-events-none"
          >
            <p class="text-sm">
              {{ t('explorer.dropToImport') }}
            </p>
          </div>
        </div>
      </UContextMenu>
      <p class="text-xs text-muted">
        {{ t('explorer.count', { n: totalCount }, totalCount) }}
      </p>
    </div>

    <!-- Screen reader announcements (moved, renamed, undo available). -->
    <div
      class="sr-only"
      aria-live="polite"
      role="status"
    >
      {{ announcement }}
    </div>

    <ExplorerMoveDialog
      v-model:open="moveOpen"
      :scope="scope"
      :folders="folders"
      :items="moveTargets"
      :root-label="rootLabel"
      :current="folderId"
      @pick="onMovePicked"
    />
    <ExplorerDeleteDialog
      v-model:open="deleteOpen"
      :items="deleteTargets"
      @confirm="onDeleteConfirmed"
    />
    <ExplorerImportDialog
      v-if="perms.canWrite"
      v-model:open="importOpen"
      :scope="scope"
      :folder-id="importFolder"
      :folder-name="folderName(importFolder)"
      :initial-files="importFiles"
      @finished="data.afterChange()"
    />
    <DocumentDuplicateDocModal
      v-if="duplicateTarget"
      v-model:open="duplicateOpen"
      :doc-id="duplicateTarget.id"
      :source-title="duplicateTarget.label"
      @duplicated="onDuplicated"
    />
    <ExplorerMobileSheets
      v-if="isMobile"
      v-model:folders-open="foldersSheetOpen"
      :folders="folders"
      :current="folderId"
      :root-label="rootLabel"
      :item="sheetItem"
      @open-folder="openFolder"
      @close-item="longPressTarget = null"
    />
  </section>
</template>

<style scoped>
:deep(tr.explorer-drop-over),
:deep([data-slot="link"].explorer-drop-over) {
  outline: 2px solid var(--ui-border-inverted);
  outline-offset: -2px;
  border-radius: 0.375rem;
}
</style>
