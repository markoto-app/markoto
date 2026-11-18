import type { InjectionKey } from 'vue'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'

// Drag and drop in the explorer (Pragmatic drag and drop: native HTML5
// events, any element can be a target). Items are dragged by row; drop
// targets are folder rows, tree nodes and breadcrumb segments. Hovering a
// target for a moment opens it ("spring-loaded" folders). The explorer
// provides the context; rows, tree nodes and breadcrumbs register through
// `useDragSource` / `useFolderDropTarget`.

export const EXPLORER_DRAG = 'markoto-explorer-items'
const SPRING_MS = 700

export interface ExplorerDndContext {
  /** Keys a drag that starts on `key` carries: the selection when the item is in it, else the item alone (and it becomes the selection). */
  dragKeysFor: (key: string) => string[]
  /** Whether those keys may be dropped into `folderId` (null = the root). */
  canDrop: (keys: readonly string[], folderId: string | null) => boolean
  /** The pointer rested on a target: open / expand it. */
  spring?: (folderId: string | null) => void
}

export const explorerDndKey: InjectionKey<ExplorerDndContext> = Symbol('explorer-dnd')

export interface DragData { type: typeof EXPLORER_DRAG, keys: string[] }
export interface DropData { type: typeof EXPLORER_DRAG, folderId: string | null }

export function isDragData(data: Record<string | symbol, unknown>): data is Record<string | symbol, unknown> & DragData {
  return data.type === EXPLORER_DRAG && Array.isArray(data.keys)
}

export function isDropData(data: Record<string | symbol, unknown>): data is Record<string | symbol, unknown> & DropData {
  return data.type === EXPLORER_DRAG && 'folderId' in data
}

/**
 * Register `el` as a drag source for `key` and, when `folderId` is given, as
 * a drop target for that folder. Re-registers when the element or the values
 * change; cleans up on unmount.
 */
export function useExplorerDragDrop(
  el: Ref<HTMLElement | null>,
  opts: { key?: () => string | null, folderId?: () => string | null | undefined, enabled?: () => boolean }
) {
  const ctx = inject(explorerDndKey, null)
  const over = ref(false)
  let cleanup: (() => void) | null = null
  let springTimer: ReturnType<typeof setTimeout> | null = null

  function clearSpring() {
    if (springTimer) clearTimeout(springTimer)
    springTimer = null
  }

  function register() {
    cleanup?.()
    cleanup = null
    const element = el.value
    if (!ctx || !element || (opts.enabled && !opts.enabled())) return
    const key = opts.key?.() ?? null
    const target = opts.folderId?.()
    const parts: Array<() => void> = []
    if (key !== null) {
      parts.push(draggable({
        element,
        getInitialData: () => ({ type: EXPLORER_DRAG, keys: ctx.dragKeysFor(key) })
      }))
    }
    if (target !== undefined) {
      parts.push(dropTargetForElements({
        element,
        getData: () => ({ type: EXPLORER_DRAG, folderId: target }),
        canDrop: ({ source }) => isDragData(source.data) && ctx.canDrop(source.data.keys, target),
        onDragEnter: () => {
          over.value = true
          clearSpring()
          if (ctx.spring) springTimer = setTimeout(() => ctx.spring?.(target), SPRING_MS)
        },
        onDragLeave: () => {
          over.value = false
          clearSpring()
        },
        onDrop: () => {
          over.value = false
          clearSpring()
        }
      }))
    }
    cleanup = combine(...parts)
  }

  watch([el, () => opts.key?.(), () => opts.folderId?.(), () => opts.enabled?.()], register, { flush: 'post' })
  onMounted(register)
  onBeforeUnmount(() => {
    clearSpring()
    cleanup?.()
  })
  return { over }
}
