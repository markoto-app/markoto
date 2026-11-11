// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { setResponseStatus } from 'h3'
import { SettingsAiProviderCard } from '#components'

// The card shows a refusal in the reader's language from its code: routes
// no longer send a `messageKey` for codes whose text is fixed
// (`ai-provider/key-required`). The server's own English detail follows it.

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})

const CONFIG = {
  capability: 'chat',
  baseUrl: 'https://api.mistral.ai/v1',
  host: 'api.mistral.ai',
  model: 'mistral-small-latest',
  apiKeyLast4: 'abcd',
  supportsVision: false,
  supportsTools: null,
  verifiedAt: null,
  lastVerifyCode: null
}

describe('AiProviderCard errors', () => {
  it('a code without messageKey shows the code\'s text, then the server detail', async () => {
    registerEndpoint('/api/user/ai-providers/chat/verify', {
      method: 'POST',
      handler: (event) => {
        setResponseStatus(event, 400)
        return { statusCode: 400, message: 'SERVER DETAIL', data: { code: 'ai-provider/key-required' } }
      }
    })
    const w = await mountSuspended(SettingsAiProviderCard, {
      props: {
        capability: 'chat',
        config: CONFIG as never,
        status: { available: true, source: 'user', platformBilled: false } as never,
        presets: []
      }
    })
    mounted.push(w)
    await w.get('[data-testid="ai-provider-verify-chat"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(w.find('[data-testid="ai-provider-message-chat"]').exists()).toBe(true))
    const text = w.get('[data-testid="ai-provider-message-chat"]').text()
    expect(text).toContain('Enter the API key')
    expect(text).toContain('SERVER DETAIL')
  })
})
