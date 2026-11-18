import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter'
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { collectDroppedFiles, type PickedFile } from '~/utils/explorer/droppedFiles'
import { isDragData, isDropData } from './useExplorerDnd'

/**
 * The import dialog's state, and files dropped from the computer onto the
 * list (which open it with those files, folders keep their structure).
 */
export function useExplorerImport(opts: { canWrite: () => boolean, currentFolder: () => string | null }) {
  const open = ref(false)
  const folder = ref<string | null>(null)
  const files = shallowRef<PickedFile[]>([])
  const dragOver = ref(false)

  function openImport(folderId: string | null, picked: PickedFile[] = []) {
    if (!opts.canWrite()) return
    folder.value = folderId
    files.value = picked
    open.value = true
  }

  function hasFiles(e: DragEvent) {
    return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
  }
  function onDragover(e: DragEvent) {
    if (!hasFiles(e) || !opts.canWrite()) return
    e.preventDefault()
    dragOver.value = true
  }
  async function onDrop(e: DragEvent) {
    dragOver.value = false
    if (!hasFiles(e) || !opts.canWrite() || !e.dataTransfer) return
    e.preventDefault()
    const dropped = await collectDroppedFiles(e.dataTransfer)
    if (dropped.length > 0) openImport(opts.currentFolder(), dropped)
  }

  return { open, folder, files, dragOver, openImport, onDragover, onDrop }
}

/**
 * Items dropped onto a folder (row, tree node, breadcrumb) of this explorer
 * call `move`; the list scrolls while an item is dragged near its edge.
 */
export function useExplorerDropMonitor(scrollEl: Readonly<Ref<HTMLElement | null>>, move: (keys: string[], folderId: string | null) => void) {
  let cleanup: (() => void) | null = null
  watch(scrollEl, (el) => {
    cleanup?.()
    cleanup = el
      ? combine(
          autoScrollForElements({ element: el }),
          monitorForElements({
            canMonitor: ({ source }) => isDragData(source.data),
            onDrop: ({ source, location }) => {
              const target = location.current.dropTargets[0]?.data
              if (target && isDropData(target) && isDragData(source.data)) move(source.data.keys, target.folderId)
            }
          })
        )
      : null
  }, { flush: 'post' })
  onBeforeUnmount(() => cleanup?.())
}
