// The explorer list as a grid: ARIA roles and counts on the table the
// component renders, roving focus (only the focused row is a tab stop),
// focusing a row that may not be rendered yet (virtualised), and loading the
// next page near the bottom.

const ROW_HEIGHT = 44

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
