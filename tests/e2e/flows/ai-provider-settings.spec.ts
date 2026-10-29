import { test, expect } from '../fixtures/flow'
import { fakeOpenAiBaseUrl } from '../../integration/setup/env'

// "Use your own AI provider" (WP4, bring your own key).
//
// User-job: connect the AI assistant to an AI account the user already
// has (Mistral, OpenAI, a model on their own server) so their own
// provider runs — and pays for — the writing assistant.
//
// What this flow shows: Settings → AI provider → pick the Mistral
// preset for the writing assistant → markoto verifies it (a
// tool-calling test call) → the card shows the host, the model and only
// the last four characters of the key.
//
// Staging: the screenshots show what a reader would do — the Mistral
// preset — but no live provider is called and no real key is needed.
// The save request is re-pointed at the test stack's fake OpenAI-
// compatible server (`fake-openai-test`, on the docker bridge, allowed
// because the flow stack sets NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true), so
// the server-side SSRF check, verification call, encryption and storage
// all run for real. Responses are mapped back to the Mistral values the
// reader picked, and the instance's private-network opt-in is hidden —
// markoto.app doesn't offer it, and readers shouldn't see a 10.x address.

const SHOWN_BASE_URL = 'https://api.mistral.ai/v1'
const SHOWN_HOST = 'api.mistral.ai'
const SHOWN_MODEL = 'mistral-small-2603'
const FAKE_MODEL = 'fake-chat'

/** Deep-replace provider strings in an API payload; hide the private-network opt-in. */
function mapPayload(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value
  if (Array.isArray(value)) return value.map(v => mapPayload(v, map))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'allowPrivate' ? false : mapPayload(v, map)
    }
    return out
  }
  return value
}

test('Use your own AI provider', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)
  await editor.page.loginAsTestUser('Maya Chen')

  const fakeBaseUrl = fakeOpenAiBaseUrl()
  const fakeHost = new URL(fakeBaseUrl).host
  const toFake = new Map([[SHOWN_BASE_URL, fakeBaseUrl], [SHOWN_MODEL, FAKE_MODEL]])
  const toShown = new Map([[fakeBaseUrl, SHOWN_BASE_URL], [fakeHost, SHOWN_HOST], [new URL(fakeBaseUrl).hostname, SHOWN_HOST], [FAKE_MODEL, SHOWN_MODEL]])
  const savedBodies: unknown[] = []
  await page.route('**/api/user/ai-providers**', async (route) => {
    const request = route.request()
    let postData: string | undefined
    if (request.method() === 'PUT' || request.method() === 'POST') {
      const raw = request.postData()
      if (raw) {
        const forwarded = mapPayload(JSON.parse(raw), toFake)
        savedBodies.push(forwarded)
        postData = JSON.stringify(forwarded)
      }
    }
    const response = await route.fetch({ postData })
    const text = await response.text()
    let body = text
    try {
      body = JSON.stringify(mapPayload(JSON.parse(text), toShown))
    } catch { /* not JSON — pass through */ }
    await route.fulfill({ response, body })
  })

  await page.goto('/settings/ai')
  const chatCard = page.getByTestId('ai-provider-card-chat')
  await chatCard.waitFor({ state: 'visible', timeout: 15_000 })

  // ─── Chapter 1: Where AI runs ──────────────────────────────────
  await flow.heading('Bring your own AI provider', 3)
  await flow.narrate(
    'markoto\'s writing assistant, image generation and voice input can run on your own AI '
    + 'provider account: Mistral, OpenAI, or any OpenAI-compatible service, including a model '
    + 'on your own server. Your provider bills you directly, and your key is stored encrypted.'
  )
  await flow.shot('Each AI feature has its own provider card', {
    highlights: [{ label: 'Writing assistant', selector: '[data-testid="ai-provider-card-chat"]' }]
  })

  // ─── Chapter 2: Add the provider ───────────────────────────────
  await flow.heading('Connect a provider for the writing assistant', 3)
  await flow.click('Click "Add your provider"', page.getByTestId('ai-provider-edit-chat'), {
    result: 'The form asks for the provider, its address, the model and your key',
    annotations: [{ label: 'Add your provider', selector: '[data-testid="ai-provider-edit-chat"]', kind: 'box' }],
    after: async () => {
      await expect(page.getByTestId('ai-provider-base-url-chat')).toBeVisible()
    }
  })

  // The form opens on the first preset (Mistral) with its address and
  // a suggested model filled in; the reader only adds the key.
  await expect(page.getByTestId('ai-provider-base-url-chat')).toHaveValue(SHOWN_BASE_URL)
  await page.getByTestId('ai-provider-model-chat').fill(SHOWN_MODEL)
  await flow.step(
    'Pick your provider (here: Mistral), check the model and paste your API key',
    () => page.getByTestId('ai-provider-api-key-chat').fill('sk-flow-demo-key-4242')
  )

  // ─── Chapter 3: Verified ───────────────────────────────────────
  await flow.heading('Save: markoto checks the connection first', 3)
  const message = page.getByTestId('ai-provider-message-chat')
  await flow.click('Click "Save and verify"', page.getByTestId('ai-provider-save-chat'), {
    result: 'The connection works: the assistant now runs on your provider',
    hero: true,
    highlights: [
      { label: 'Verified', selector: '[data-testid="ai-provider-message-chat"]' },
      { label: 'Only the last four characters are shown', selector: '[data-testid="ai-provider-key-chat"]' }
    ],
    after: async () => {
      await expect(message).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('ai-provider-key-chat')).toBeVisible()
    }
  })
  await expect(page.getByTestId('ai-provider-source-chat')).toHaveText(/your key/i)
  await expect(page.getByTestId('ai-provider-key-chat')).toContainText('4242')
  await expect(page.getByTestId('ai-provider-key-chat')).not.toContainText('sk-flow-demo')
  await expect(page.getByTestId('ai-provider-host-chat')).toHaveText(SHOWN_HOST)
  // The save really went to the server, verified against the fake
  // provider the request was re-pointed at.
  expect(savedBodies.some(b => JSON.stringify(b).includes(fakeBaseUrl))).toBe(true)
  await expect(page.getByText(/private network/i)).toHaveCount(0)
  await flow.narrate(
    'Before saving, markoto sent a small test request with a tool definition through the '
    + 'same path the assistant uses, so a wrong key or an unknown model is caught here, not '
    + 'in the middle of your writing. You can re-check it with Verify or remove it at any time.'
  )

  flow.next({ slug: 'ai-prompt-bar', why: 'Ask the assistant to write with your own provider' })
})
