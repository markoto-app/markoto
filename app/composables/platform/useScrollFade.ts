import type { MaybeRefOrGetter } from 'vue'
import { scrollFadeEdges } from '~/utils/platform/scrollFade'

/**
 * Edge fades for a strip that scrolls sideways without a scrollbar (the
 * workspace tab strip): reports which edges hide content, kept current on
 * scroll, on resize and when the strip's content changes. Pair with the
 * `mk-scroll-fade` classes in `main.css`.
 */
export function useScrollFade(target: MaybeRefOrGetter<HTMLElement | null | undefined>) {
  const start = ref(false)
  const end = ref(false)

  function update(): void {
    const el = toValue(target)
    const edges = el ? scrollFadeEdges(el.scrollLeft, el.scrollWidth, el.clientWidth) : { start: false, end: false }
    start.value = edges.start
    end.value = edges.end
  }

  // A mouse wheel has no sideways axis, and the strip has no scrollbar to
  // drag: turn the wheel into sideways scrolling while the strip can still
  // move that way, and let the page scroll once it is at the end.
  function onWheel(event: WheelEvent): void {
    const el = toValue(target)
    if (!el || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
    const edges = scrollFadeEdges(el.scrollLeft, el.scrollWidth, el.clientWidth)
    if (event.deltaY > 0 ? !edges.end : !edges.start) return
    event.preventDefault()
    el.scrollLeft += event.deltaY
  }

  useEventListener(target, 'scroll', update, { passive: true })
  useEventListener(target, 'wheel', onWheel, { passive: false })
  useResizeObserver(target, update)
  useMutationObserver(target, update, { childList: true, subtree: true, characterData: true })
  watch(() => toValue(target), update, { immediate: true, flush: 'post' })

  /** Classes for the strip: no scrollbar, and a fade on each edge that hides content. */
  const fadeClass = computed(() => [
    'mk-scroll-fade',
    start.value ? 'mk-scroll-fade--start' : '',
    end.value ? 'mk-scroll-fade--end' : ''
  ].filter(Boolean).join(' '))

  return { start, end, fadeClass, update }
}
