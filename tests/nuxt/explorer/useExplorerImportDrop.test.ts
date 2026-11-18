// @vitest-environment nuxt
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { useExplorerImport } from '~/composables/explorer/useExplorerImportDrop'
import { useExplorerLongPress } from '~/composables/explorer/useExplorerLongPress'
import { docItem } from '~/utils/explorer/model'
import { doc } from './fixtures'

// Files dragged from the computer onto the explorer open the import dialog
// with what was dropped, in the folder on screen; only for people who may
// add documents, and only for real files (not a dragged row or text). A
// long press on a phone selects the row and opens its sheet, swallowing the
// click that follows lifting the finger.

function dragEvent(types: string[], files: File[] = []): DragEvent {
  const e = new Event('drop', { cancelable: true }) as DragEvent
  Object.defineProperty(e, 'dataTransfer', {
    value: {
      types,
      files,
      items: files.map(f => ({ kind: 'file', getAsFile: () => f }))
    }
  })
  return e
}

describe('useExplorerImport', () => {
  it('opens the dialog for a folder, not for a viewer', () => {
    let canWrite = false
    const imp = useExplorerImport({ canWrite: () => canWrite, currentFolder: () => 'f1' })
    imp.openImport('f2')
    expect(imp.open.value).toBe(false)
    canWrite = true
    imp.openImport('f2')
    expect(imp.open.value).toBe(true)
    expect(imp.folder.value).toBe('f2')
    expect(imp.files.value).toEqual([])
  })

  it('highlights a drag of files and imports the drop into the current folder', async () => {
    const imp = useExplorerImport({ canWrite: () => true, currentFolder: () => 'f1' })
    const over = dragEvent(['Files'])
    imp.onDragover(over)
    expect(over.defaultPrevented).toBe(true)
    expect(imp.dragOver.value).toBe(true)

    const file = new File(['# a'], 'a.md')
    const drop = dragEvent(['Files'], [file])
    await imp.onDrop(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(imp.dragOver.value).toBe(false)
    expect(imp.open.value).toBe(true)
    expect(imp.folder.value).toBe('f1')
    expect(imp.files.value).toEqual([{ path: 'a.md', file }])
  })

  it('ignores dragged text, an empty drop, and drops of a viewer', async () => {
    const imp = useExplorerImport({ canWrite: () => true, currentFolder: () => null })
    const text = dragEvent(['text/plain'])
    imp.onDragover(text)
    expect(text.defaultPrevented).toBe(false)
    expect(imp.dragOver.value).toBe(false)
    await imp.onDrop(dragEvent(['Files'], []))
    expect(imp.open.value).toBe(false)

    const viewer = useExplorerImport({ canWrite: () => false, currentFolder: () => null })
    const drop = dragEvent(['Files'], [new File(['x'], 'x.md')])
    viewer.onDragover(drop)
    await viewer.onDrop(drop)
    expect(drop.defaultPrevented).toBe(false)
    expect(viewer.open.value).toBe(false)
  })
})

describe('useExplorerLongPress', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function rowTarget(key: string): HTMLElement {
    document.body.innerHTML = `<table><tbody><tr data-key="${key}"><td><span id="cell">x</span></td></tr></tbody></table>`
    return document.getElementById('cell')!
  }

  it('on a phone: selects the pressed row, opens its sheet and swallows the next click', () => {
    const item = docItem(doc('d1'))
    const selectOnly = vi.fn()
    const lp = useExplorerLongPress({ isMobile: ref(true), find: k => (k === item.key ? item : undefined), selectOnly })
    lp.onLongPress({ target: rowTarget(item.key) } as unknown as PointerEvent)
    expect(selectOnly).toHaveBeenCalledWith(item.key)
    expect(lp.longPressTarget.value).toEqual(item)

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    // Only that one click.
    const next = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(next)
    expect(next.defaultPrevented).toBe(false)
  })

  it('does nothing with a mouse or outside a row', () => {
    const item = docItem(doc('d1'))
    const selectOnly = vi.fn()
    const desktop = useExplorerLongPress({ isMobile: ref(false), find: () => item, selectOnly })
    desktop.onLongPress({ target: rowTarget(item.key) } as unknown as PointerEvent)
    const phone = useExplorerLongPress({ isMobile: ref(true), find: () => undefined, selectOnly })
    phone.onLongPress({ target: rowTarget('gone') } as unknown as PointerEvent)
    expect(selectOnly).not.toHaveBeenCalled()
    expect(desktop.longPressTarget.value).toBeNull()
    expect(phone.longPressTarget.value).toBeNull()
  })
})
