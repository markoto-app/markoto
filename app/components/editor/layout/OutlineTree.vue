<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import type { EditorView } from '@codemirror/view'
import { parseMarkdownTokens } from '~/utils/markdown/renderMarkdown'
import {
  activeHeadingIndex, buildOutlineTree, headingsFromTokens, maskFrontmatter,
  type OutlineHeading, type OutlineNode
} from '~/utils/editor/documentOutline'
import { subscribeViewUpdates } from '~/utils/editor/viewUpdateHub'
import { topVisibleLine } from '~/utils/editor/outlineJump'

// The Outline tab of the editor's left panel: the document's headings as a
// tree, rebuilt from the text a moment after typing stops (only while the
// tab is shown). The current section follows the cursor and the editor's
// scroll position. UTree gives the ARIA tree and its keyboard (arrows,
// Home / End, Right / Left expand and collapse, Enter jumps). A click on
// an entry jumps; only the chevron collapses a section.

const props = defineProps<{
  /** The document text. */
  source: string
  /** The editor, when it is on screen (not in preview-only mode). */
  view: EditorView | null
}>()

const emit = defineEmits<{ select: [heading: OutlineHeading] }>()

const { t } = useI18n()

/** Quiet time after the last keystroke before the outline is rebuilt. */
const REBUILD_DEBOUNCE_MS = 300

const headings = shallowRef<OutlineHeading[]>([])
const ready = ref(false)
let parsedSource: string | null = null
let run = 0

async function rebuild(source: string): Promise<void> {
  if (source === parsedSource) return
  parsedSource = source
  const mine = ++run
  try {
    const tokens = await parseMarkdownTokens(maskFrontmatter(source))
    if (mine === run) headings.value = headingsFromTokens(tokens)
  } catch (err: unknown) {
    // Keep the last outline; the next edit tries again.
    console.warn('[outline] could not read the headings', err)
    parsedSource = null
  } finally {
    if (mine === run) ready.value = true
  }
}

const rebuildSoon = useDebounceFn((source: string) => {
  void rebuild(source)
}, REBUILD_DEBOUNCE_MS)
watch(() => props.source, (source) => {
  void rebuildSoon(source)
})
onMounted(() => {
  void rebuild(props.source)
})

// Where the person is: the cursor's line after it moves, the line at the
// top of the editor after a scroll, whichever happened last. Without an
// editor (preview only) the entry clicked last.
const activeLine = ref(-1)
const pickedIndex = ref(-1)

watch(() => props.view, (view, _old, onCleanup) => {
  if (!view) return
  activeLine.value = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const unsubscribe = subscribeViewUpdates(view, (update) => {
    if (update.selectionSet) activeLine.value = update.state.doc.lineAt(update.state.selection.main.head).number - 1
  })
  // At most once a frame.
  let frame = 0
  const onScroll = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      activeLine.value = topVisibleLine(view)
    })
  }
  view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
  onCleanup(() => {
    unsubscribe()
    view.scrollDOM.removeEventListener('scroll', onScroll)
    cancelAnimationFrame(frame)
  })
}, { immediate: true })

const activeIndex = computed(() => props.view ? activeHeadingIndex(headings.value, activeLine.value) : pickedIndex.value)

interface Item extends TreeItem {
  key: string
  index: number
  children?: Item[]
}

const tree = computed(() => buildOutlineTree(headings.value))

const items = computed<Item[]>(() => {
  const seen = new Set<string>()
  const toItem = (n: OutlineNode): Item => {
    // The anchor id is unique and stays put while text is added elsewhere,
    // so a collapsed section stays collapsed; an explicit id used twice
    // falls back to the position.
    const base = n.heading.id || `#${n.index}`
    const key = seen.has(base) ? `${base}#${n.index}` : base
    seen.add(key)
    return {
      key,
      index: n.index,
      label: n.heading.text,
      ...(n.children.length > 0 ? { children: n.children.map(toItem) } : {})
    }
  }
  return tree.value.map(toItem)
})

const flatItems = computed(() => {
  const out: Item[] = []
  const walk = (list: Item[]) => {
    for (const item of list) {
      out.push(item)
      if (item.children) walk(item.children)
    }
  }
  walk(items.value)
  return out
})

const selected = computed(() => flatItems.value.find(i => i.index === activeIndex.value))

// Every section starts expanded; what the person collapsed stays collapsed.
const collapsed = ref(new Set<string>())
const parentKeys = computed(() => flatItems.value.filter(i => i.children).map(i => i.key))
const expanded = computed<string[]>({
  get: () => parentKeys.value.filter(k => !collapsed.value.has(k)),
  set: (keys) => {
    const open = new Set(keys)
    collapsed.value = new Set(parentKeys.value.filter(k => !open.has(k)))
  }
})

type TreeEvent = CustomEvent<{ originalEvent: Event }>

function onSelect(e: TreeEvent, item: Item) {
  // The selection marks the current section, which the jump itself moves.
  e.preventDefault()
  const heading = headings.value[item.index]
  if (!heading) return
  pickedIndex.value = item.index
  emit('select', heading)
}

function onToggle(e: TreeEvent) {
  // A click on the entry jumps; only its chevron (or Right / Left) collapses.
  const original = e.detail.originalEvent
  if (original.type !== 'click') return
  const target = original.target as Element | null
  if (!target?.closest('[data-outline-chevron]')) e.preventDefault()
}

// Keep the current section in view inside the panel while the editor scrolls.
const root = useTemplateRef<HTMLElement>('root')
watch(activeIndex, async (index) => {
  await nextTick()
  if (!root.value || root.value.contains(document.activeElement)) return
  root.value.querySelector(`[data-outline-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div
    ref="root"
    class="p-2"
    data-testid="outline"
  >
    <div
      v-if="ready && items.length === 0"
      class="flex flex-col items-center gap-2 px-4 py-10 text-center"
      data-testid="outline-empty"
    >
      <UIcon
        name="i-lucide-list-tree"
        class="size-6 text-muted"
      />
      <p class="text-sm text-default">
        {{ t('leftPanel.outline.emptyTitle') }}
      </p>
      <p class="text-xs text-muted">
        {{ t('leftPanel.outline.emptyHint') }}
      </p>
    </div>
    <UTree
      v-else-if="items.length > 0"
      v-model:expanded="expanded"
      :model-value="selected"
      :items="items"
      :get-key="(item: Item) => item.key"
      :on-select="onSelect"
      :on-toggle="onToggle"
      :aria-label="t('leftPanel.tabs.outline')"
      color="neutral"
      size="sm"
      :ui="{ link: 'data-[selected]:bg-(--explorer-selected-bg) data-[selected]:text-highlighted' }"
      data-testid="outline-tree"
    >
      <!-- Headings, not folders: no leading icon (UTree's default is a
           folder). An empty slot would fall back to that default. -->
      <template #item-leading>
        <span
          class="hidden"
          aria-hidden="true"
        />
      </template>
      <template #item-label="{ item }">
        <span
          class="truncate"
          :title="String(item.label)"
          :data-outline-index="(item as Item).index"
        >{{ item.label }}</span>
      </template>
      <template #item-trailing="{ item, expanded: isOpen }">
        <UIcon
          v-if="(item as Item).children?.length"
          name="i-lucide-chevron-down"
          data-outline-chevron
          class="size-4 shrink-0 text-dimmed transition-transform"
          :class="isOpen ? '' : '-rotate-90'"
        />
      </template>
    </UTree>
  </div>
</template>
