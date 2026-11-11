// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { CommonUserAvatar } from '#components'
import { avatarColors } from '~/utils/collab/userAvatar'
import { renderAvatarDataUri } from '~/utils/collab/userAvatarRender'

async function settle() {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 0))
    await nextTick()
  }
}

describe('<CommonUserAvatar>', () => {
  it('shows the seed\'s background disc at once and the locally rendered face after the lazy renderer loads', async () => {
    const wrapper = await mountSuspended(CommonUserAvatar, { props: { seed: 'u-7', name: 'Alice', size: 32 } })
    const disc = wrapper.find('[data-testid="user-avatar"]')
    expect(disc.attributes('style')).toContain('width: 32px')
    expect(disc.attributes('aria-label')).toBe('Alice')
    expect(disc.attributes('role')).toBe('img')
    await settle()
    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(renderAvatarDataUri('u-7'))
    expect(img.attributes('alt')).toBe('')
    // Disc colour = the face's background, so nothing jumps when it loads.
    expect(disc.attributes('style')?.toLowerCase()).toContain(`background-color: ${avatarColors('u-7').background.toLowerCase()}`)
  })

  it('is decorative (aria-hidden) without a name', async () => {
    const wrapper = await mountSuspended(CommonUserAvatar, { props: { seed: 'u-8' } })
    expect(wrapper.find('[data-testid="user-avatar"]').attributes('aria-hidden')).toBe('true')
  })

  it('re-renders when the seed changes', async () => {
    const wrapper = await mountSuspended(CommonUserAvatar, { props: { seed: 'u-1' } })
    await settle()
    await wrapper.setProps({ seed: 'u-2' })
    await settle()
    expect(wrapper.find('img').attributes('src')).toBe(renderAvatarDataUri('u-2'))
  })
})
