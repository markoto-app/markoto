import { test, expect, settlePreview, useOwnMistralKey } from '../tour/fixture'
import { demoDocument as demo } from '../tour/content/demoDocument'

// Demo video only (scripts/demo-video/): a new document started from a
// template in the new-document dialog. The product tour has no such
// scene; the video shows it in the themes chapter. Same recorder as the
// tour (step-by-step 2x frames + clip.json), output under
// $TOUR_OUTPUT_DIR/<mode>/templates/.

const TEMPLATE = 'proposal'
const TITLE = 'Harbour Freight proposal'

test('Video: start from a template', async ({ page, editor, tour }) => {
  test.setTimeout(240_000)
  await editor.page.loginAsTestUser(demo.author)
  // As in the tour: the AI on the user's own key (no points meter).
  await useOwnMistralKey(page)
  await page.goto('/')
  const newDoc = page.locator('[data-testid="landing-new-document"]').first()
  await newDoc.waitFor({ state: 'visible' })
  const dialog = editor.page.newDocDialog
  // Hydrated before recording: the server render shows the button before
  // its click handler is attached, so open the dialog once (retrying, as
  // silentSetup does) and close it again.
  await expect(async () => {
    await newDoc.click()
    await expect(dialog.heading).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 15_000 })
  await dialog.cancel.click()
  await expect(dialog.titleInput).toBeHidden()

  const clip = await tour.clip('templates')
  await clip.frame(6)
  await clip.click(newDoc, { after: () => expect(dialog.titleInput).toBeVisible() })
  await clip.frame(3)
  await clip.click(dialog.titleInput)
  await clip.type(TITLE, 3)
  await clip.frame(3)
  await clip.click(dialog.section('template'), {
    after: () => expect(page.getByTestId('template-tabs')).toBeVisible()
  })
  await clip.frame(4)
  await expect(dialog.titleInput).toBeVisible()
  // The business templates, then pick one.
  await clip.click(page.getByTestId('template-tabs').getByRole('tab', { name: 'Business' }), {
    after: () => expect(dialog.templateCard('memo')).toBeVisible()
  })
  await clip.frame(4)
  await clip.moveTo(dialog.templateCard('report'), 8)
  await clip.frame(3)
  await clip.click(dialog.templateCard(TEMPLATE), {
    after: () => expect(dialog.summary('template')).not.toHaveText('')
  })
  await clip.frame(6)
  await expect(dialog.titleInput).toHaveValue(TITLE)
  await clip.click(dialog.submitCreate, {
    after: async () => {
      await editor.page.waitForReady(30_000)
      await editor.page.waitForPreviewPaginated(30_000)
    }
  })
  await clip.cursor(false)
  await settlePreview(page, 1500)
  await expect(editor.page.titleButton).toContainText(TITLE)
  await editor.page.dismissToasts().catch(() => {})
  await clip.frame(12)
  await clip.done({
    description: 'A new document started from the proposal template: the editor opens with its text and design.',
    focus: page.locator('iframe').first(),
    endHold: 1
  })
})
