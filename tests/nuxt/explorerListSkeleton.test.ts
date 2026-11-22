// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ListSkeleton from '~/components/explorer/ListSkeleton.vue'

describe('ExplorerListSkeleton', () => {
  it('stands in for the rows while the first fetch is pending', async () => {
    const wrapper = await mountSuspended(ListSkeleton)
    const root = wrapper.find('[data-testid="explorer-skeleton"]')
    expect(root.attributes('role')).toBe('status')
    expect(root.element.children).toHaveLength(5)
  })
})
