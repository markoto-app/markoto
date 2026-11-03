import { test, expect } from '@playwright/test'
import { smokeDoc } from './_helpers'

// Baseline "the app actually works" smoke: an anonymous doc loads, the
// CodeMirror editor mounts, edits enter the buffer, and the live paged.js
// preview (in the srcdoc iframe) actually paginates. A blank preview would
// mean the vendored-asset/render pipeline is broken.
test('anonymous doc loads, editor mounts, live preview paginates', async ({ page }) => {
  // Shared run document (globalSetup.ts) — never a new one per attempt.
  const docId = smokeDoc('demo')
  await page.goto(`/d/${docId}`)

  await expect(page.locator('.cm-editor')).toBeVisible()
  // The seeded Demo content lands via Hocuspocus sync.
  await expect(page.locator('.cm-content')).toContainText('markoto', { timeout: 30_000 })

  // Editing works.
  await page.locator('.cm-content').click()
  await page.keyboard.type(' SMOKE_MARKER_42')
  await expect(page.locator('.cm-content')).toContainText('SMOKE_MARKER_42')

  // Live preview paginates (desktop default view is split, so the iframe is
  // mounted). At least one paged.js page = the /vendor/ assets + render pipeline are alive.
  const preview = page.frameLocator('iframe')
  await expect(preview.locator('.pagedjs_page').first()).toBeVisible({ timeout: 45_000 })
})
