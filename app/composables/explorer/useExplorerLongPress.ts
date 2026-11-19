import type { ExplorerItem } from '~/utils/explorer/model'

// Phone long press on a row: selects it and opens its action sheet. The
// click that follows lifting the finger would land on the sheet that just
// opened under it (and close it), so that one click is swallowed.

export function useExplorerLongPress(opts: {
  isMobile: Readonly<Ref<boolean>>
  find: (key: string) => ExplorerItem | undefined
  selectOnly: (key: string) => void
}) {
  const target = shallowRef<ExplorerItem | null>(null)

  function onLongPress(e: PointerEvent) {
    // Touch only: a long press with the mouse stays a plain press.
    if (!opts.isMobile.value) return
    const key = (e.target as HTMLElement | null)?.closest<HTMLElement>('tr[data-key]')?.dataset.key
    const item = key ? opts.find(key) : undefined
    if (!item) return
    opts.selectOnly(item.key)
    target.value = item
    const swallow = (ev: MouseEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 800)
  }

  return { longPressTarget: target, onLongPress }
}
