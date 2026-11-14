// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { WorkspaceRemoveMemberModal } from '#components'

// Removing someone from a workspace asks first. With single sign-on on, the
// person can rejoin through the identity provider, so the dialog says to
// remove them there too.

async function open(ssoActive: boolean) {
  const wrapper = await mountSuspended(WorkspaceRemoveMemberModal, {
    props: { open: true, name: 'Bob', ssoActive, busy: false },
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

const find = (testid: string) => document.body.querySelector(`[data-testid="${testid}"]`)

describe('remove-member dialog', () => {
  it('names the person and confirms with Remove', async () => {
    const wrapper = await open(false)
    expect(document.body.textContent).toContain('Remove Bob?')
    expect(find('workspace-remove-member-sso-note')).toBeNull()
    ;(find('workspace-remove-member-confirm') as HTMLElement).click()
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  it('with single sign-on, says the identity provider can let them back in', async () => {
    const wrapper = await open(true)
    expect(find('workspace-remove-member-sso-note')?.textContent).toContain('identity provider')
    wrapper.unmount()
  })
})
