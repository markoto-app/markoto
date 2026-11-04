import { test, expect } from '@playwright/test'
import { smokeDoc } from './_helpers'

// The mobile bottom-sheet drawer collapsed to 0×0 on every Android browser:
// the UA styles `dialog { width/height: fit-content }`, the sheet's only child
// is position:absolute (out of flow), so the dialog computed 0×0 and the sheet
// rendered off-screen. Tapping a bottom tab flipped the open state but nothing
// painted. This asserts the sheet renders with REAL dimensions on tap — it
// would have failed with the 0×0 dialog.
test('mobile bottom-sheet drawer opens with real size on tab tap', async ({ page }) => {
  // Shared run document (globalSetup.ts) — never a new one per attempt.
  const docId = smokeDoc('demo')
  await page.goto(`/d/${docId}`)
  await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 30_000 })

  const tabBar = page.locator('[data-testid="mobile-tab-bar"]')
  await expect(tabBar).toBeVisible()

  // First button is the "Editor" tab — a drawer toggle. (The mic tab is a
  // direct action and sits second; we deliberately tap a drawer tab.)
  await tabBar.locator('button').first().click()

  const sheet = page.locator('.mk-sheet')
  await expect(sheet, 'bottom sheet should be visible after tapping a tab').toBeVisible({ timeout: 5_000 })

  const box = await sheet.boundingBox()
  expect(box, 'sheet must have a bounding box').not.toBeNull()
  expect(box!.width, 'sheet width (regressed to 0)').toBeGreaterThan(200)
  expect(box!.height, 'sheet height (regressed to 0)').toBeGreaterThan(100)
})
