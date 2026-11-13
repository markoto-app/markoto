// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentDocRowMenu } from '#components'

// The document row "…" menu opens from its trigger button (the parent holds the open state, exactly like the
// dashboard / workspace rows do for long-press); a one-way `:open` binding would keep it closed. Pins: the
// trigger opens it, the items match the caller's permissions, and the action items emit (Open / Open in new
// tab are links).

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
let deletes = 0

async function mountMenu(perms: { canEdit: boolean, canManage: boolean }) {
  const Host = defineComponent({
    setup() {
      const open = ref(false)
      return () => h(DocumentDocRowMenu, {
        'docId': 'doc1',
        'canEdit': perms.canEdit,
        'canManage': perms.canManage,
        'open': open.value,
        'onUpdate:open': (v: boolean) => { open.value = v },
        'onDelete': () => { deletes++ }
      })
    }
  })
  const wrapper = await mountSuspended(Host, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

async function openMenu(wrapper: Wrapper): Promise<void> {
  const trigger = wrapper.get('[data-testid="doc-row-menu"]')
  // Reka's trigger opens on a left-button click without modifiers.
  await trigger.trigger('click', { button: 0, ctrlKey: false })
  await flushPromises()
  // The content mounts in a portal on the next render.
  await vi.waitFor(() => {
    if (!document.body.querySelector('[role="menu"]')) throw new Error('menu not open')
  })
}

function actionIds(): string[] {
  return Array.from(document.body.querySelectorAll('[data-testid^="doc-row-action-"]'))
    .map(el => el.getAttribute('data-testid')?.replace('doc-row-action-', '') ?? '')
}

function actionItem(action: string): HTMLElement {
  const label = document.body.querySelector(`[data-testid="doc-row-action-${action}"]`)
  const item = label?.closest('[role="menuitem"]')
  if (!(item instanceof HTMLElement)) throw new Error(`no menu item for ${action}`)
  return item
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
  deletes = 0
})

describe('DocRowMenu', () => {
  it('opens on the trigger and shows every action to a manager', async () => {
    const wrapper = await mountMenu({ canEdit: true, canManage: true })
    expect(actionIds()).toEqual([])
    await openMenu(wrapper)
    expect(wrapper.get('[data-testid="doc-row-menu"]').attributes('aria-expanded')).toBe('true')
    expect(actionIds()).toEqual(['open', 'openNewTab', 'duplicate', 'move', 'delete'])
  })

  it('an editor who does not manage the doc gets no Move / Delete', async () => {
    const wrapper = await mountMenu({ canEdit: true, canManage: false })
    await openMenu(wrapper)
    expect(actionIds()).toEqual(['open', 'openNewTab', 'duplicate'])
  })

  it('a viewer can only open the doc', async () => {
    const wrapper = await mountMenu({ canEdit: false, canManage: false })
    await openMenu(wrapper)
    expect(actionIds()).toEqual(['open', 'openNewTab'])
  })

  it('Open links to the doc, Open in new tab targets a new tab', async () => {
    const wrapper = await mountMenu({ canEdit: true, canManage: true })
    await openMenu(wrapper)
    expect(actionItem('open').getAttribute('href')).toBe('/d/doc1')
    expect(actionItem('openNewTab').getAttribute('href')).toBe('/d/doc1')
    expect(actionItem('openNewTab').getAttribute('target')).toBe('_blank')
  })

  it('Delete emits `delete`', async () => {
    const wrapper = await mountMenu({ canEdit: true, canManage: true })
    await openMenu(wrapper)
    actionItem('delete').click()
    await flushPromises()
    expect(deletes).toBe(1)
  })
})
