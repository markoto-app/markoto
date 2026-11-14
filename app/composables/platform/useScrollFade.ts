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

  useEventListener(target, 'scroll', update, { passive: true })
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
