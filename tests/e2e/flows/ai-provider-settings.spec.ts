import { test, expect } from '../fixtures/flow'
import { fakeOpenAiBaseUrl } from '../../integration/setup/env'

// "Use your own AI provider" (WP4, bring your own key).
//
// User-job: connect the AI assistant to an AI account the user already
// has (Mistral, OpenAI, a model on their own server) so their own
// provider runs — and pays for — the writing assistant.
//
// What this flow shows: Settings → AI provider → add a provider for the
// writing assistant → markoto verifies it (a tool-calling test call) →
// the card shows the host, the model and only the last four characters
// of the key. The provider here is the test stack's fake OpenAI-
// compatible server (`fake-openai-test`), reachable on the docker
// bridge; the flow stack allows private-network providers like a
// self-hosted instance would (NUXT_AI_BYOK_ALLOW_PRIVATE_URLS=true in
// scripts/flows-ephemeral.ts). No live AI provider is called.

test('Use your own AI provider', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)
  await editor.page.loginAsTestUser('Maya Chen')

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

  const baseUrl = fakeOpenAiBaseUrl()
  await page.getByTestId('ai-provider-base-url-chat').fill(baseUrl)
  await page.getByTestId('ai-provider-model-chat').fill('fake-chat')
  await flow.step(
    'Enter the provider address, the model and your API key',
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
  await flow.narrate(
    'Before saving, markoto sent a small test request with a tool definition through the '
    + 'same path the assistant uses, so a wrong key or an unknown model is caught here, not '
    + 'in the middle of your writing. You can re-check it with Verify or remove it at any time.'
  )

  flow.next({ slug: 'ai-prompt-bar', why: 'Ask the assistant to write with your own provider' })
})
