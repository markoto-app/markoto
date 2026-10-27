// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from 'reka-ui'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { CollabPresenceBar as PresenceBar } from '#components'
import { AWARENESS_FALLBACK_COLOR } from '~~/shared/utils/awarenessUser'

// Awareness states are chosen by each peer and relayed verbatim. A peer
// could put CSS into `user.color` (lands in inline styles), a script URL
// into `user.avatar` (lands in <img src>) or a non-string name (crashed
// the initials helper). PresenceBar must render all of that safely.

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
    // Fallback name "Anonymous" → initial "A".
    expect(wrapper.text()).toContain('A')
  })

  it('drops a peer whose user field is not an object', async () => {
    const awareness = new Awareness(new Y.Doc())
    const wrapper = await mountBar(awareness)
    receiveRemoteState(awareness, { user: 'not-an-object' })
    await nextTick()
    expect(wrapper.find('.ring-2').exists()).toBe(false)
  })
})
