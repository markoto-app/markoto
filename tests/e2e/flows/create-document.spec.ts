import { test } from '../fixtures/flow'
import { expect } from '@playwright/test'

// Real end-to-end flow: anonymous user creates a doc, switches to a
// useful view mode, names it. This exercises POST /api/docs, the
// redirect to /d/{docId}, the editor mount + Hocuspocus connect, the
// view-mode toggle (which doubles as a workaround for an init-order
// quirk where the editor briefly defaults to preview mode), and the
// inline title rename.
//
// Selector notes:
// - UTooltip in @nuxt/ui v4 sets aria-describedby (NOT aria-label) on
//   wrapped buttons, so getByRole('button', { name: ... }) does not
//   match icon-only toolbar buttons. We locate them via their inner
//   `iconify` span class.
// - getByRole works for buttons with text content (e.g. "New Document").

test('Create a new document', async ({ page, flow }) => {
  await flow.heading('Creating your first document')
  await flow.narrate(
    'YPad lets you create a document anonymously — no signup needed. '
    + 'You can claim it later by linking an account.'
  )

  await flow.step('Open the YPad homepage', async () => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /new document/i })).toBeVisible()
  })

  await flow.narrate(
    'The hero pitch + "New Document" button is the funnel for anonymous '
    + 'visitors. Logged-in users also see "New Workspace" alongside.'
  )

  await flow.step('Click "New Document" to spin up a fresh anonymous doc', async () => {
    // Trigger click + wait for navigation in parallel — doing the wait
    // BEFORE the click would race; AFTER would miss fast navigations.
    await Promise.all([
      page.waitForURL(/\/d\/[^/]+/),
      page.getByRole('button', { name: /new document/i }).click()
    ])
  })

  await flow.step('The editor mounts and Hocuspocus connects', async () => {
    // "Connected" text appears inside the connection badge once the WS
    // handshake completes. The title button shows "Untitled" by default.
    await expect(page.locator('header').getByText('Connected')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('header button').filter({ hasText: 'Untitled' })).toBeVisible()
  })

  await flow.heading('Switching to split view', 3)
  await flow.narrate(
    'New docs land in preview mode briefly. The three icons in the '
    + 'header center toggle between editor-only, split, and preview-only. '
    + 'Click the middle one — split view — to see the source AND the '
    + 'rendered preview side by side.'
  )

  await flow.step('Click the split-view toggle (middle icon)', async () => {
    // Locate by the unique iconify class on the inner icon span. Escaping
    // the colon in the Tailwind-style class with a backslash is required
    // for CSS selectors (`.i-lucide\\:columns-2`).
    const splitBtn = page.locator('header button:has(.i-lucide\\:columns-2)')
    await splitBtn.click()
    // Confirm the button latched into the active state — primary color
    // is bound to viewMode === 'split'.
    await expect(splitBtn).toHaveClass(/bg-primary/)
  })

  await flow.heading('Renaming the document', 3)
  await flow.narrate(
    'The title sits in the top-left header. Clicking it swaps the '
    + 'display for an inline text input, focuses it, and selects all — '
    + 'so you can start typing immediately.'
  )

  await flow.step('Click the "Untitled" label to start renaming', async () => {
    await page.locator('header button').filter({ hasText: 'Untitled' }).click()
    // Wait for the swap from <button> to <input> to complete.
    await expect(page.locator('header input').first()).toBeFocused()
  })

  await flow.step('Type your new title and press Enter to save', async () => {
    // The input auto-focuses + auto-selects, so a plain `pressSequentially`
    // overwrites the placeholder. Per-keystroke events trigger the Y.js
    // title bridge (matches real user behaviour better than `fill`).
    await page.locator('header input').first().pressSequentially('My first doc')
    await page.keyboard.press('Enter')
    // Wait for the input to be replaced with the saved-title button
    // before screenshotting — otherwise we capture mid-blur state.
    await expect(page.locator('header button').filter({ hasText: 'My first doc' })).toBeVisible()
  })

  await flow.shot('The new title is saved — no save button needed')

  await flow.heading('The status bar', 3)
  await flow.narrate(
    'The footer always shows live word + character counts on the left, '
    + 'and the sync state on the right. Watching "Synced" appear is how '
    + 'you know your edits made it to the server.'
  )

  await flow.shot('Two things to watch in the status bar', {
    highlights: [
      { label: 'Word + char count', selector: '[data-testid="word-count"]' },
      { label: 'Sync status', selector: '[data-testid="sync-status"]' }
    ]
  })
})

