import { test, expect } from '../fixtures/flow'

// Flow: "Suggest and review changes".
//
// User-job: a supervisor reviews a student's chapter without touching
// the text; the student decides what goes in. Job done when the reviewer's
// suggestions show in the student's editor and the student has accepted
// one and rejected the other.
//
// Two people: Maya (the owner) requires suggestions in the share dialog;
// Sam (a spawned, separately signed-in browser) opens the link, finds
// himself in Suggesting mode and proposes two changes; Maya accepts and
// rejects them from the Suggestions panel. Short lines keep each sentence
// on one visual line on a phone (Home / Shift+End select it whole).

const BODY = [
  '# Chapter 2: Method',
  '',
  'We interviewed twelve teachers.',
  '',
  'Notes were taken by hand.',
  '',
  'All names are pseudonyms.'
].join('\n')

test('Suggest and review changes', async ({ page, flow, editor }) => {
  test.setTimeout(150_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({ title: 'Thesis: chapter 2', body: BODY, cover: false })
  // Sam (spawned below) opens the link: anyone with it can edit, and
  // will have to suggest.
  await editor.page.setAccessMode('open-edit')
  const docUrl = page.url()

  await flow.heading('Ask for suggestions', 3)
  await flow.narrate(
    'Want feedback without losing control of the text? Turn on suggestions in '
    + 'the share dialog. Everyone else then proposes changes instead of making '
    + 'them, and you decide what goes in. You keep editing directly.'
  )
  await flow.click(
    'Open the share dialog',
    editor.page.accessLockButton,
    { chain: true, after: () => page.getByTestId('share-modal').waitFor({ state: 'visible', timeout: 10_000 }) }
  )
  const required = page.locator('[data-testid="suggestion-settings-required"][role="switch"], [data-testid="suggestion-settings-required"] [role="switch"]').first()
  await required.scrollIntoViewIfNeeded()
  await flow.click(
    'Turn on "Everyone suggests changes"',
    required,
    {
      force: editor.isMobile,
      result: 'From now on, other people\'s changes arrive as suggestions.',
      highlights: [{ label: 'Suggestions', selector: '[data-testid="suggestion-settings"]' }]
    }
  )
  await expect(required).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')

  // Sam suggests
  await flow.heading('Your reviewer suggests changes', 3)
  await flow.narrate(
    'Sam opens the same link. The switch in the top bar says Suggesting and '
    + 'stays there: whatever he types is shown as a proposal, underlined in '
    + 'his colour, and whatever he deletes is struck through. The text itself '
    + 'does not change.'
  )
  const sam = await flow.spawn('sam')
  await sam.editor.loginAsTestUser('Sam Reeves')
  await sam.page.goto(docUrl)
  await sam.editor.waitForReady()
  await expect(sam.editor.suggestions.modeToggle).toHaveAttribute('data-mode', 'suggesting')

  const samContent = sam.page.locator('.cm-content')
  await sam.flow.step('Sam rewrites a sentence: the old one is struck through, the new one underlined', async () => {
    await samContent.getByText('We interviewed twelve teachers.').click()
    await sam.page.keyboard.press('Home')
    await sam.page.keyboard.press('Shift+End')
    await sam.page.keyboard.type('We interviewed fourteen teachers.')
  })
  await expect(sam.editor.suggestions.inserted.filter({ hasText: 'fourteen' })).toBeVisible()

  await sam.flow.step('Sam suggests deleting a sentence: it is struck through until you decide', async () => {
    await samContent.getByText('Notes were taken by hand.').click()
    await sam.page.keyboard.press('End')
    await sam.page.keyboard.press('Shift+Home')
    await sam.page.keyboard.press('Backspace')
  })
  await expect(sam.editor.suggestions.struck).toHaveCount(2)
  // Still the original text: suggestions are not edits.
  await expect(samContent).toContainText('We interviewed twelve teachers.')

  // Maya reviews
  await flow.heading('Accept or reject', 3)
  await flow.narrate(
    'On your screen the suggestions appear as Sam types. Open the Suggestions '
    + 'panel: each suggestion has a card with who proposed it, when, and buttons '
    + 'to accept or reject. On a phone, tap a suggestion in the text to open its card.'
  )
  await expect(editor.page.suggestions.struck).toHaveCount(2, { timeout: 10_000 })
  if (editor.isMobile) {
    await flow.click('Tap the suggested sentence', editor.page.suggestions.inserted.first(), {
      result: 'Its card opens with Accept and Reject.',
      after: () => editor.page.suggestions.panel.waitFor({ state: 'visible' })
    })
  } else {
    await flow.click('Open the Suggestions panel', editor.page.sidebar.suggestions, {
      result: 'Every open suggestion has a card, in the order of the text.',
      after: () => editor.page.suggestions.panel.waitFor({ state: 'visible' })
    })
  }
  await expect(editor.page.suggestions.card).toHaveCount(2)

  const rewrite = editor.page.suggestions.card.filter({ hasText: 'fourteen' })
  await flow.click('Accept the rewritten sentence', editor.page.suggestions.acceptIn(rewrite), {
    force: editor.isMobile,
    result: 'The new sentence is now part of the text, recorded as Sam\'s edit.'
  })
  await expect(page.locator('.cm-content')).toContainText('We interviewed fourteen teachers.', { timeout: 15_000 })

  const deletion = editor.page.suggestions.card.filter({ hasText: 'Notes were taken by hand.' })
  await flow.click('Reject the deletion', editor.page.suggestions.rejectIn(deletion), {
    force: editor.isMobile,
    hero: true,
    result: 'The sentence stays as it was, and the suggestion is gone.'
  })
  await expect(editor.page.suggestions.card).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.cm-content')).toContainText('Notes were taken by hand.')
  await expect(page.locator('.cm-content')).not.toContainText('twelve')

  // Sam sees the outcome without a reload.
  await expect(samContent).toContainText('We interviewed fourteen teachers.', { timeout: 10_000 })
  await expect(sam.editor.suggestions.struck).toHaveCount(0)

  flow.next({
    slug: 'have-a-discussion',
    why: 'Discuss a passage in a comment thread'
  })
})
