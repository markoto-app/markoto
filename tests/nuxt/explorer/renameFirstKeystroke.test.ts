// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { ExplorerRowName } from '#components'
import { folderItem } from '~/utils/explorer/model'

// A new folder starts as "New folder" with the name selected. If the
// selection is lost before the first keystroke (a re-render, a focus handed
// back by a closing menu), typing must still replace the whole name, not
// land in front of it ("ResearchNew folder").
const folder = folderItem({ folderId: '1', parentId: null, name: 'New folder', docCount: 0, updatedAt: '2026-11-19T00:00:00Z' })

describe('<ExplorerRowName> rename', () => {
  it('the first typed character replaces the untouched name even with the caret at the start', async () => {
    const wrapper = await mountSuspended(ExplorerRowName, { props: { item: folder, selected: true, focused: true, renaming: true, rowIndex: 0, draggable: false } })
    await nextTick()
    const input = wrapper.find('input').element as HTMLInputElement
    input.setSelectionRange(0, 0)
    const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 'R', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    await nextTick()
    expect(ev.defaultPrevented).toBe(true)
    expect(input.value).toBe('R')
  })

  it('after the caret was moved, typing edits the name normally', async () => {
    const wrapper = await mountSuspended(ExplorerRowName, { props: { item: folder, selected: true, focused: true, renaming: true, rowIndex: 0, draggable: false } })
    await nextTick()
    const input = wrapper.find('input')
    await input.trigger('keydown', { key: 'End' })
    const ev = new InputEvent('beforeinput', { inputType: 'insertText', data: 's', bubbles: true, cancelable: true })
    input.element.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect((input.element as HTMLInputElement).value).toBe('New folder')
  })
})
