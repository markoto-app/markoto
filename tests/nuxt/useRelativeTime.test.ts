// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { useRelativeTime } from '~/composables/platform/useRelativeTime'

// Relative times in the UI language; a time slightly in the future (a
// server clock ahead of the browser's) reads as "now", never "in 8 seconds".

async function label(at: Date): Promise<string> {
  const wrapper = await mountSuspended(defineComponent({
    setup() {
      const text = useRelativeTime(at)
      return () => h('span', text.value)
    }
  }))
  const out = wrapper.text()
  wrapper.unmount()
  return out
}

describe('useRelativeTime', () => {
  it('formats a past time', async () => {
    expect(await label(new Date(Date.now() - 5 * 60_000))).toMatch(/5 minutes ago/)
  })

  it('clamps a future time to now', async () => {
    const text = await label(new Date(Date.now() + 8_000))
    expect(text).not.toMatch(/^in /)
    expect(text).toMatch(/now/)
  })
})
