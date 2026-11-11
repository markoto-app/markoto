// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from 'reka-ui'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { CollabPresenceBar as PresenceBar } from '#components'
import { AWARENESS_FALLBACK_COLOR } from '~~/shared/utils/documents/awarenessUser'

// Awareness states are chosen by each peer and relayed verbatim. A peer
// could put CSS into `user.color` (lands in inline styles), an image URL
// into `user.avatar` (would make every viewer fetch it) or a non-string
// name. PresenceBar must render all of that safely — and avatars are
// generated locally, never loaded from a URL a peer chose.

registerEndpoint('/api/docs/doc-presence/members', () => ({ members: [] }))

// UTooltip needs a Reka TooltipProvider ancestor (UApp provides it in the app).
function mountBar(awareness: Awareness) {
  return mountSuspended(defineComponent({
    render: () => h(TooltipProvider, null, {
      default: () => h(PresenceBar, { awareness, docId: 'doc-presence' })
    })
  }))
}

/** Deliver `state` to `target` as if it came from a remote peer. */
function receiveRemoteState(target: Awareness, state: Record<string, unknown>) {
  const peer = new Awareness(new Y.Doc())
  peer.setLocalState(state)
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote')
}

describe('<PresenceBar> — hostile awareness payloads', () => {
  it('renders a peer with a non-string name, CSS in the colour and a script avatar safely', async () => {
    const awareness = new Awareness(new Y.Doc())
    const wrapper = await mountBar(awareness)
    receiveRemoteState(awareness, {
      user: {
        name: 42,
        color: 'red; position: fixed; inset: 0; z-index: 9999',
        avatar: 'javascript:alert(1)'
      }
    })
    await nextTick()

    const html = wrapper.html()
    expect(html).not.toContain('position: fixed')
    expect(html).not.toContain('javascript:')
    expect(html.toLowerCase()).toContain(AWARENESS_FALLBACK_COLOR.toLowerCase())
    // A generated avatar, seeded per connection (no id, no token).
    const avatar = wrapper.find('[data-testid="user-avatar"]')
    expect(avatar.exists()).toBe(true)
    expect(avatar.attributes('data-avatar-seed')).toMatch(/^x-\d+$/)
    expect(avatar.attributes('aria-label')).toBe('Anonymous')
  })

  it('never puts a peer-supplied avatar URL into an <img src>', async () => {
    const awareness = new Awareness(new Y.Doc())
    const wrapper = await mountBar(awareness)
    receiveRemoteState(awareness, {
      user: { name: 'Mallory', color: '#7A8C7E', id: 5, avatar: 'https://tracker.example/pixel.png' }
    })
    await nextTick()
    expect(wrapper.html()).not.toContain('tracker.example')
    for (const img of wrapper.findAll('img')) {
      expect(img.attributes('src') ?? '').toMatch(/^data:image\/svg\+xml/)
    }
  })

  it('drops a peer whose user field is not an object', async () => {
    const awareness = new Awareness(new Y.Doc())
    const wrapper = await mountBar(awareness)
    receiveRemoteState(awareness, { user: 'not-an-object' })
    await nextTick()
    expect(wrapper.find('.ring-2').exists()).toBe(false)
  })
})

describe('<PresenceBar> — avatar seeds', () => {
  it('seeds signed-in peers by user id and anonymous peers by their session token', async () => {
    const awareness = new Awareness(new Y.Doc())
    const wrapper = await mountBar(awareness)
    receiveRemoteState(awareness, { user: { name: 'Alice', color: '#7A8C7E', id: 7 } })
    receiveRemoteState(awareness, { user: { name: 'Quiet Fox', color: '#8C7E6B', avatarSeed: 'Ab3dEf6hIj9kLm2n' } })
    await nextTick()
    const seeds = wrapper.findAll('[data-testid="user-avatar"]').map(a => a.attributes('data-avatar-seed'))
    expect(seeds).toContain('u-7')
    expect(seeds).toContain('a-Ab3dEf6hIj9kLm2n')
  })

  it('keeps the seal disc for the AI collaborator', async () => {
    const awareness = new Awareness(new Y.Doc())
    const wrapper = await mountBar(awareness)
    receiveRemoteState(awareness, { user: { name: 'markoto', color: '#7A8C7E', id: 1, isAI: true } })
    await nextTick()
    expect(wrapper.find('[data-testid="user-avatar"]').exists()).toBe(false)
    expect(wrapper.find('.mk-seal').exists()).toBe(true)
  })
})
