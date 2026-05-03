import { test, expect } from '../fixtures/flow'

// Tier 2 (mobile sibling): "Tell the AI who you're writing for —
// on mobile."
//
// Same payoff as document-context.spec.ts: set audience + language +
// description, then ask the AI for an intro and watch it tailor
// the output. Different surface: the Document panel mounts in a
// bottom sheet via the Document tab on the mobile bar.
//
// Live Gemini call. Mobile-only.
test('Tell the AI who you\'re writing for on mobile', async ({ page, flow, editor }) => {
  test.skip(
    !editor.isMobile,
    'Mobile-only sibling — desktop story is in document-context.spec.ts.'
  )
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows.'
  )
  test.setTimeout(360_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()

  await flow.heading('Tell the AI who you\'re writing for on mobile', 3)
  await flow.narrate(
    'Every doc carries four context fields beyond the title: a '
    + 'description, a target audience, a language, and the template '
    + 'it was created from. The AI sees them on every prompt — set '
    + 'them once, and the AI tailors its output without you '
    + 'mentioning audience or language in your prompt. On mobile, '
    + 'the Document tab on the bottom bar opens the same panel '
    + 'desktop users see in the right sidebar.'
  )

  // ─── Open the Document drawer ───────────────────────────────────
  await flow.click(
    'Tap the Document tab on the bottom bar',
    editor.page.mobileTabs.document,
    {
      result: 'The Document drawer slides up — Description, Language, Audience, Template.',
      after: () => page.locator('#doc-description').waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // ─── Set the three fields ───────────────────────────────────────
  await flow.heading('Set audience, language, description', 3)
  await flow.narrate(
    'Description is one line that tells the AI what this document IS. '
    + 'Audience is a closed enum of writing registers. Language is '
    + 'free text — six curated presets plus typed input for anything '
    + 'else.'
  )

  await flow.type(
    'Type a one-line description',
    page.locator('#doc-description'),
    'Onboarding-Email für neu registrierte Nutzer.',
    {
      result: 'The description is captured.'
    }
  )

  // Audience: USelect — Reka renders the popover in a portal, but
  // on mobile the drawer's `mk-sheet-host` keeps capturing pointer
  // events even though it carries `aria-hidden="true"`. flow.click's
  // hover-then-click can't penetrate that. Use flow.step with a
  // forced click to bypass the actionability check (Playwright's
  // strict mode treats the intercepting drawer as "not actionable").
  await flow.step(
    'Open the Audience dropdown',
    async () => {
      await page.locator('#doc-audience').click({ force: true })
      await page.getByRole('option', { name: /marketing/i }).first().waitFor({ state: 'visible' })
    },
    { result: 'The audience options appear.' }
  )
  await flow.step(
    'Pick "Marketing / SEO"',
    async () => {
      await page.getByRole('option', { name: /marketing/i }).first().click({ force: true })
      await page.locator('#doc-audience').waitFor({ state: 'visible' })
    },
    { result: 'The audience switches to Marketing.' }
  )

  // Language: UInputMenu — typing into the input opens the filter
  // popover. Same drawer-intercepts pointer issue, so use force.
  await flow.step(
    'Type "Deutsch" in Language',
    async () => {
      await page.locator('#doc-language').click({ force: true })
      await page.locator('#doc-language').pressSequentially('Deutsch')
      await page.getByRole('option', { name: /deutsch/i }).first().waitFor({ state: 'visible', timeout: 5_000 })
    },
    { result: 'The Deutsch preset surfaces in the suggestions.' }
  )
  await flow.step(
    'Tap "Deutsch"',
    async () => {
      await page.getByRole('option', { name: /deutsch/i }).first().click({ force: true })
      await page.waitForTimeout(500)
    },
    { result: 'The language switches to Deutsch.' }
  )

  // Close the drawer so the AI prompt bar is reachable. The drawer
  // covers the bottom tab bar AND intercepts pointer events on it,
  // so tapping the Document tab again can't close it. Press Escape
  // — the drawer host listens for Escape on the document and closes
  // cleanly.
  await flow.step(
    'Close the drawer (Escape)',
    async () => {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
    },
    { result: 'The drawer slides down — the editor + AI prompt bar are visible again.' }
  )

  // ─── Ask the AI ─────────────────────────────────────────────────
  await flow.heading('Ask the AI for an intro', 3)
  await flow.narrate(
    'With audience + language + description set, ANY prompt the AI '
    + 'sees gets shaped by them — without you mentioning them in '
    + 'your prompt. We ask for a one-line intro in plain English; '
    + 'the AI returns marketing-tone Deutsch.'
  )

  await flow.click(
    'Tap the AI prompt bar to focus it',
    editor.page.ai.promptBarInput,
    {
      result: 'The prompt bar lifts — ready for your prompt.'
    }
  )

  const prompt = 'Write a one-line welcome intro at the top.'
  await flow.type(
    'Type a plain-English ask',
    editor.page.ai.promptBarInput,
    prompt,
    {
      result: 'The ask is short and English. The audience + language fields do the rest.'
    }
  )

  await flow.click(
    'Tap send',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — the bar pulses while the agentic loop runs.',
      after: () => editor.page.waitForAiActive()
    }
  )

  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI added a one-line intro — German body, marketing tone — '
    + 'shaped by the document context, not by anything in the prompt.',
    {
      hero: true,
      highlights: [
        { label: 'AI\'s edits', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: doc grew.
  const doc = page.locator('.cm-content')
  const wordCount = await doc.evaluate(el => (el.textContent ?? '').split(/\s+/).filter(Boolean).length)
  expect(wordCount).toBeGreaterThan(50)

  flow.next({
    slug: 'pick-a-theme',
    why: 'Now match the visual style — pick a theme that fits the audience'
  })
})
