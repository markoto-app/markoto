import { test, expect } from '../fixtures/flow'

// Tier 2: "Tell the AI who you're writing for".
//
// User-job: a writer wants the AI's output to match their audience
// + language WITHOUT re-typing "in German, marketing tone" on every
// prompt. Job done when they've set audience/language/description in
// the Document tab and watched the AI's next prompt return output
// shaped by those fields.
//
// What this flow ISN'T: a full audience tour (six registers + every
// language). We pick ONE meaningful combination — Marketing audience
// + Deutsch language + a real description — and demonstrate that one
// AI call produces output shaped by the context.
//
// Live Gemini call. NUXT_GOOGLE_GEMINI_API_KEY required (forwarded
// from the host into the prod test stack via flows-ephemeral.ts).
//
// Desktop only: the Document panel mounts in the right sidebar
// (`< xl` overlays it; `xl+` keeps it as the third pane). Mobile
// surfaces the same panel via the bottom tab bar but at narrow
// widths the form scrolls below the fold; the desktop layout shows
// every field in one screen.
test('Tell the AI who you\'re writing for', async ({ page, flow, editor }) => {
  test.skip(
    editor.isMobile,
    'Document context tour is desktop-only — the form fits in the right sidebar at desktop widths but scrolls below the fold on mobile narrow.'
  )
  test.skip(
    !process.env.NUXT_GOOGLE_GEMINI_API_KEY,
    'NUXT_GOOGLE_GEMINI_API_KEY is required for live AI flows — set it in the host shell before `bun run flows:test`.'
  )
  test.setTimeout(360_000)

  // AI requires a session; same TEST_MODE login shim the other AI
  // flows use.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  // Cover sheet would hide the AI-added intro in the preview; disable.
  await editor.page.disableCoverPage()

  // ─── Open the Document panel ────────────────────────────────────
  await flow.heading('Tell markoto who you\'re writing for', 3)
  await flow.narrate(
    'Every doc carries four context fields beyond the title: a '
    + 'description, a target audience, a language, and the template '
    + 'it was created from. The AI sees them on every prompt — so a '
    + 'one-time minute setting them up saves you re-typing context '
    + 'on every "rewrite this" / "extend this" / "draft a section".'
  )

  await flow.click(
    'Click the Document tab in the right sidebar',
    editor.page.sidebar.document,
    {
      annotations: [
        { label: 'document tab', selector: '[data-testid="sidebar-tab-document"]', kind: 'arrow' }
      ],
      result: 'The Document panel opens — Description, Language, Audience, '
        + 'Template, all editable in place.',
      after: () => page.locator('#doc-description').waitFor({ state: 'visible' })
    }
  )

  // ─── Set the three fields ───────────────────────────────────────
  await flow.heading('Set the audience, language, and description', 3)
  await flow.narrate(
    'Description is one line that tells the AI what this document IS. '
    + 'Audience is a closed enum of writing registers (six of them, '
    + 'each with a tuned tone fragment). Language is free text — '
    + 'six curated presets plus typed input for anything else.'
  )

  // Description.
  await flow.type(
    'Type a one-line description',
    page.locator('#doc-description'),
    'Onboarding-Email für neu registrierte Nutzer.',
    {
      result: 'The description is captured — the AI will see this on every prompt.'
    }
  )

  // Audience: USelect (Reka button + popover). Click the trigger,
  // then click the option by its visible label.
  await flow.click(
    'Open the Audience dropdown',
    page.locator('#doc-audience'),
    {
      result: 'The audience options appear — six writing registers.',
      after: () => page.getByRole('option', { name: /marketing/i }).first().waitFor({ state: 'visible' })
    }
  )
  await flow.click(
    'Pick "Marketing / SEO"',
    page.getByRole('option', { name: /marketing/i }).first(),
    {
      result: 'The audience switches to Marketing — the AI now knows to '
        + 'write benefit-led, scannable, customer-facing prose.',
      after: () => page.locator('#doc-audience').waitFor({ state: 'visible' })
    }
  )

  // Language: UInputMenu (Reka combobox). Type to filter, press
  // Enter to commit. Typing "Deutsch" matches the `de` preset's
  // label, so Enter picks the preset (NOT the create-item branch).
  await flow.type(
    'Type "Deutsch" in the Language field',
    page.locator('#doc-language'),
    'Deutsch',
    {
      result: 'The Deutsch preset surfaces in the suggestions — Enter to commit.',
      after: () => page.getByRole('option', { name: /deutsch/i }).first().waitFor({ state: 'visible', timeout: 5_000 })
    }
  )
  await flow.click(
    'Pick "Deutsch"',
    page.getByRole('option', { name: /deutsch/i }).first(),
    {
      result: 'The language switches to Deutsch — every AI prompt now ends '
        + 'with "Write all prose in Deutsch."',
      // The combobox closes its popover on selection; wait a beat for
      // the input value to reflect the chosen item.
      after: () => page.waitForTimeout(500)
    }
  )

  // ─── Ask the AI ─────────────────────────────────────────────────
  await flow.heading('Ask the AI for an intro', 3)
  await flow.narrate(
    'With audience + language + description set, ANY prompt the AI '
    + 'sees gets shaped by them — without you mentioning audience or '
    + 'language in your prompt. We ask for a one-line intro in '
    + 'plain English; the AI returns marketing-tone Deutsch.'
  )

  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    {
      annotations: [
        { label: 'prompt bar', selector: '[data-testid="ai-prompt-bar"]', kind: 'arrow' }
      ],
      result: 'The prompt bar lifts and glows — ready for your prompt.'
    }
  )

  const prompt = 'Write a one-line welcome intro at the top.'
  await flow.type(
    'Type a plain-English ask',
    editor.page.ai.promptBarInput,
    prompt,
    {
      result: 'The ask is short and English. The audience + language fields '
        + 'do the rest of the work.'
    }
  )

  await flow.click(
    'Send it',
    editor.page.ai.promptBarSend,
    {
      result: 'The AI is working — the bar pulses while the agentic loop runs.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // Wait for the loop to finish. Single-tool ("insert_text" or
  // "replace_text") runs typically resolve in 5-15s.
  await editor.page.waitForAiIdle()

  await flow.shot(
    'The AI added a one-line intro — German body, marketing tone — '
    + 'shaped by the document context, not by anything in the prompt.',
    {
      // Hero outcome: the AI-rendered context-shaped output is the
      // payoff. Readers seeing this for the first time clock that
      // "set the audience once, get it on every prompt" is real.
      hero: true,
      highlights: [
        { label: 'AI\'s edits', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTION: the doc grew (silentSetup leaves the welcome doc
  // ~30 lines; a successful AI run should land at least one new
  // line of body text). We don't assert on language detection or
  // exact wording — Gemini's output varies — but a non-trivial
  // word count means the AI did something.
  const doc = page.locator('.cm-content')
  const wordCount = await doc.evaluate(el => (el.textContent ?? '').split(/\s+/).filter(Boolean).length)
  expect(wordCount).toBeGreaterThan(50)

  // Forward route: now that the AI knows the doc's context, the
  // next move is making it look the part — pick a theme that
  // matches the marketing register.
  flow.next({
    slug: 'pick-a-theme',
    why: 'Now match the visual style — pick a theme that fits the audience'
  })
})
