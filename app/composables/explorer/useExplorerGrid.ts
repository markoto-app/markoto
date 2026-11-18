// The explorer list as a grid: ARIA roles and counts on the table the
// component renders, roving focus (only the focused row is a tab stop),
// focusing a row that may not be rendered yet (virtualised), and loading the
// next page near the bottom.

const ROW_HEIGHT = 44
/** The list never gets shorter than this (a short window scrolls the page instead). */
const MIN_LIST_HEIGHT = 320
/** Room left under the explorer for the page's bottom padding. */
const PAGE_BOTTOM = 32

/**
 * Full-height layout: the list (and the folder tree beside it) end where the
 * window ends, so the page itself does not scroll and only the list does.
 * Measured from the elements' place in the page and what the explorer shows
 * under the list (its count line), so the same code fits the workspace
 * page and the personal dashboard.
 */
export function useExplorerHeight(rootEl: Readonly<Ref<HTMLElement | null>>, listEl: Readonly<Ref<HTMLElement | null>>, treeEl: Readonly<Ref<HTMLElement | null>>) {
  const { height: windowHeight } = useWindowSize()
  const listTop = ref(0)
  const treeTop = ref(0)
  const below = ref(0)
  function measure() {
    const el = listEl.value
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY
    listTop.value = top
    const root = rootEl.value?.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    below.value = Math.max(0, (root ? root.bottom - box.bottom : 0)) + PAGE_BOTTOM
    const tree = treeEl.value
    treeTop.value = tree ? tree.getBoundingClientRect().top + window.scrollY : top
  }
  if (import.meta.client) {
    watch(listEl, () => nextTick(measure), { flush: 'post', immediate: true })
    useResizeObserver(() => document.body, measure)
    useEventListener(window, 'resize', measure)
  }
  const listHeight = computed(() => Math.max(MIN_LIST_HEIGHT, Math.floor(windowHeight.value - listTop.value - below.value)))
  const treeHeight = computed(() => listHeight.value + (listTop.value - treeTop.value))
  return { listHeight, treeHeight }
}

export function useExplorerGrid(opts: {
  scrollEl: Readonly<Ref<HTMLElement | null>>
  keys: Readonly<Ref<string[]>>
  focus: () => string | null
  totalCount: () => number
  label: () => string
  hasNextPage: () => boolean
  isLoading: () => boolean
  loadNextPage: () => void
}) {
  function rowEl(key: string): HTMLElement | null {
    return opts.scrollEl.value?.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(key)}"]`) ?? null
  }

  function focusRow(key: string | null) {
    if (!key) return
    void nextTick(() => {
      const root = opts.scrollEl.value
      const tr = rowEl(key)
      if (tr) {
        tr.focus({ preventScroll: true })
        tr.scrollIntoView({ block: 'nearest' })
        return
      }
      // Not rendered (virtualised): scroll near it, then focus it.
      const index = opts.keys.value.indexOf(key)
      if (root && index >= 0) root.scrollTop = Math.max(0, index * ROW_HEIGHT - root.clientHeight / 2)
      setTimeout(() => rowEl(key)?.focus(), 50)
    })
  }

  watchEffect(() => {
    const root = opts.scrollEl.value
    const table = root?.querySelector('table')
    if (!root || !table) return
    table.setAttribute('role', 'grid')
    table.setAttribute('aria-multiselectable', 'true')
    table.setAttribute('aria-rowcount', String(opts.totalCount()))
    table.setAttribute('aria-label', opts.label())
    const focus = opts.focus() ?? opts.keys.value[0] ?? null
    for (const tr of root.querySelectorAll<HTMLElement>('tbody tr[data-key]')) tr.tabIndex = focus !== null && tr.dataset.key === focus ? 0 : -1
  })

  useInfiniteScroll(opts.scrollEl, () => {
    if (opts.hasNextPage() && !opts.isLoading()) opts.loadNextPage()
  }, { distance: 300, canLoadMore: opts.hasNextPage })

  return { focusRow, rowHeight: ROW_HEIGHT }
}
