import { test, expect, requireLiveAi } from '../fixtures/flow'

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
// Live LiteLLM round-trip → Mistral. MISTRAL_API_KEY required (forwarded
// from the host into the LiteLLM proxy via flows-ephemeral.ts).
//
// Runs on desktop AND mobile. Same Document panel + AI prompt
// pipeline; entry point differs:
//   - Desktop: right-sidebar Document tab.
//   - Mobile: bottom-tab-bar Info/Document tab (opens the same panel
//     in a bottom sheet). Form fields scroll below the fold at narrow
//     widths but the asserted server state + AI output are identical.
// (Until Phase 6.30 there was a `document-context-mobile.spec.ts`
//  sibling carrying mobile-specific narration. Deleted as part of the
//  "single canonical spec per feature" cleanup — Flow.vue auto-routes
//  variants by viewport via `useMediaQuery('(max-width: 639px)')`.)
// Small, high-frequency function words: enough to tell a German
// sentence from an English one without a language-detection library.
const GERMAN_WORDS = new Set(['und', 'der', 'die', 'das', 'mit', 'sie', 'ihr', 'ihre', 'ihren', 'für', 'bei', 'ist', 'wir', 'ein', 'eine', 'einen', 'zu', 'dein', 'deine', 'deinem', 'dich', 'dir', 'du', 'willkommen', 'auf', 'in', 'von', 'nicht', 'jetzt', 'schon'])
const ENGLISH_WORDS = new Set(['the', 'and', 'with', 'your', 'you', 'for', 'is', 'we', 'to', 'of', 'welcome', 'our', 'get', 'started'])

test('Tell the AI who you\'re writing for', async ({ page, flow, editor }) => {
  requireLiveAi()
  test.setTimeout(360_000)

  // AI requires a session; same TEST_MODE login shim the other AI
  // flows use.
  await editor.page.loginAsTestUser('Maya Chen')
  // A short German draft of an onboarding email, cover off so the
  // preview's first page shows the intro the AI is about to add.
  const draftBody = '# Willkommen bei Lumen\n\n## Deine ersten Schritte\n\n- Profil anlegen\n- Team einladen\n- Erstes Projekt starten\n'
  await editor.silentSetup({ title: 'Onboarding-Email', body: draftBody, cover: false })

  // ─── Open the Document panel ────────────────────────────────────
  await flow.heading('Tell markoto who you\'re writing for', 3)
  await flow.narrate(
    'Every doc carries four context fields beyond the title: a '
    + 'description, a target audience, a language, and the template '
    + 'it was created from. The AI sees them on every prompt — so a '
    + 'one-time minute setting them up saves you re-typing context '
    + 'on every "rewrite this" / "extend this" / "draft a section".'
  )

  // Desktop: right-sidebar Document tab; mobile: bottom-tab-bar
  // Info entry that opens the same panel in a sheet.
  const documentTab = editor.isMobile
    ? editor.page.mobileTabs.document
    : editor.page.sidebar.document

  await flow.click(
    editor.isMobile ? 'Tap the Info tab on the bottom bar' : 'Click the Document tab in the right sidebar',
    documentTab,
    {
      annotations: editor.isMobile
        ? []
        : [{ label: 'document tab', selector: '[data-testid="sidebar-tab-document"]', kind: 'arrow' }],
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
      // Mobile: Document panel renders inside the BottomSheet portal.
      // Pointer events on the input are intercepted by Reka's overlay.
      // See `tests/e2e/AGENTS.md` "Bottom-sheet portal interception".
      force: editor.isMobile,
      result: 'The description is captured — the AI will see this on every prompt.'
    }
  )

  // Audience: USelect (Reka button + popover). The mobile branch used to
  // need synthetic PointerEvents because the option popover rendered BEHIND
  // the bottom sheet (untappable). That was a real product bug — now fixed
  // by lifting select/combobox popovers above the sheet (main.css) — so both
  // mobile and desktop select with plain clicks. The branch remains only
  // because the desktop version records richer flow-doc annotations.
  if (editor.isMobile) {
    // Real clicks — the option popover now stacks above the bottom sheet
    // (main.css z-index fix), so no synthetic-PointerEvent workaround needed.
    await flow.step(
      'Open the Audience dropdown',
      async () => {
        await page.locator('#doc-audience').click()
        await page.getByRole('option', { name: /marketing/i }).first().waitFor({ state: 'visible' })
      },
      { result: 'The audience options appear.' }
    )
    await flow.step(
      'Pick "Marketing / SEO"',
      async () => {
        await page.getByRole('option', { name: /marketing/i }).first().click()
        await page.locator('#doc-audience').waitFor({ state: 'visible' })
      },
      { result: 'The audience switches to Marketing.' }
    )
  } else {
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
  }

  // Language: UInputMenu (Reka combobox).
  if (editor.isMobile) {
    await flow.step(
      'Type "Deutsch" in Language',
      async () => {
        await page.locator('#doc-language').click()
        // Clear the current language ("English") first — otherwise
        // pressSequentially appends to it ("DeutschEnglish") and the Deutsch
        // preset never matches.
        await page.locator('#doc-language').fill('')
        await page.locator('#doc-language').pressSequentially('Deutsch')
        await page.getByRole('option', { name: /deutsch/i }).first().waitFor({ state: 'visible', timeout: 5_000 })
      },
      { result: 'The Deutsch preset surfaces in the suggestions.' }
    )
    await flow.step(
      'Tap "Deutsch"',
      async () => {
        await page.getByRole('option', { name: /deutsch/i }).first().click()
        await expect(page.locator('#doc-language')).toHaveValue('Deutsch')
      },
      { result: 'The language switches to Deutsch.' }
    )
  } else {
    // Clear the current language ("English") first — typing into the
    // field appends, and "EnglishDeutsch" matches no preset (that is
    // what an earlier published frame showed).
    await page.locator('#doc-language').fill('')
    await expect(page.locator('#doc-language')).toHaveValue('')
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
        result: 'The language switches to Deutsch — the AI now writes in German, '
          + 'whatever language you ask in.',
        after: () => expect(page.locator('#doc-language')).toHaveValue('Deutsch')
      }
    )
  }
  await expect(page.locator('#doc-language')).toHaveValue('Deutsch')

  // ASSERTION: the context is saved on the document — that saved copy
  // is what the AI reads with every prompt.
  const contextDocId = editor.page.currentDocId()
  await expect.poll(async () => {
    const res = await page.request.get(`/api/docs/${contextDocId}/meta`)
    const meta: unknown = res.ok() ? await res.json() : null
    return JSON.stringify(meta)
  }, { timeout: 10_000, message: 'audience / language / description never reached the server' })
    .toMatch(/(?=.*"audience":"marketing")(?=.*"language":"(de|Deutsch)")(?=.*Onboarding-Email für neu registrierte Nutzer)/)

  // ─── Ask the AI ─────────────────────────────────────────────────
  await flow.heading('Ask the AI for an intro', 3)
  await flow.narrate(
    'With audience + language + description set, ANY prompt the AI '
    + 'sees gets shaped by them — without you mentioning audience or '
    + 'language in your prompt. We ask for a one-line intro in '
    + 'plain English; the AI returns marketing-tone Deutsch.'
  )

  // On mobile the Document panel still owns a `mk-sheet-host` overlay
  // that intercepts taps on the AI prompt bar. Close it first via
  // Escape (BottomSheet's host listens on `document` for keydown).
  if (editor.isMobile) {
    await page.keyboard.press('Escape')
    await page.locator('.mk-sheet-host').waitFor({ state: 'detached', timeout: 5_000 })
  }

  await flow.click(
    'Click into the AI prompt bar',
    editor.page.ai.promptBarInput,
    {
      annotations: editor.isMobile
        ? []
        : [{ label: 'prompt bar', selector: '[data-testid="ai-prompt-bar"]', kind: 'arrow' }],
      result: 'The prompt bar lifts and glows — ready for your prompt.'
    }
  )

  const prompt = 'Write a one-line welcome intro right below the main heading.'
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
      result: 'The AI is working — the bar pulses until it is done.',
      after: () => editor.page.waitForAiActive()
    }
  )

  // Wait for the loop to finish. Single-tool ("insert_text" or
  // "replace_text") runs typically resolve in 5-15s.
  await editor.page.waitForAiIdle()

  // ASSERTION: the AI added an intro, and it is German. The new lines
  // are whatever wasn't in the draft; a German intro carries German
  // function words and few English ones.
  const after = await editor.page.docText()
  const draftLines = new Set(draftBody.split('\n'))
  const added = after.split('\n').filter(l => l.trim() && !draftLines.has(l)).join('\n')
  expect(added.length, 'the AI added no text').toBeGreaterThan(20)
  const words = added.toLowerCase().match(/[a-zäöüß]+/g) ?? []
  const german = words.filter(w => GERMAN_WORDS.has(w)).length
  const english = words.filter(w => ENGLISH_WORDS.has(w)).length
  expect(german, `intro doesn't read as German: ${added}`).toBeGreaterThanOrEqual(2)
  expect(german, `intro reads as English: ${added}`).toBeGreaterThan(english)
  // ...and it is visible where the reader looks: in the editor and on
  // the preview's first page.
  const anchorWord = (added.match(/[A-Za-zÄÖÜäöüß]{6,}/) ?? [''])[0]
  expect(anchorWord).not.toBe('')
  await editor.page.scrollEditorTo(anchorWord)
  if (!editor.isMobile) {
    await editor.page.waitForPreviewPaginated()
    await expect(editor.page.previewRoot().locator('#mount')).toContainText(anchorWord)
  }

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

  // Forward route: now that the AI knows the doc's context, the
  // next move is making it look the part — pick a theme that
  // matches the marketing register.
  flow.next({
    slug: 'pick-a-theme',
    why: 'Now match the visual style — pick a theme that fits the audience'
  })
})
