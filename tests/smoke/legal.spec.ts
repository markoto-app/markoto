import { test, expect } from '@playwright/test'
import { apiFetch } from './_helpers'

// content/legal/*.md are read at runtime by /api/_internal/legal/:slug via
// fs. They weren't COPYed into the prod Docker image, so every /legal/* page
// 500'd in prod while working in dev. This asserts every legal document
// renders real HTML through the content API + the page mounts in a browser.
const SLUGS = ['privacy', 'terms', 'dpa', 'abuse-policy', 'imprint']

test('every legal document renders via the content API', async () => {
  for (const slug of SLUGS) {
    const res = await apiFetch(`/api/_internal/legal/${slug}?locale=en`)
    expect(res.status, `${slug} → ${res.status}`).toBe(200)
    const body = await res.json() as { html?: string }
    expect((body.html ?? '').length, `${slug} html length`).toBeGreaterThan(200)
    expect(body.html, `${slug} should render an <h1>`).toContain('<h1')
  }
})

test('sub-processors registry renders', async () => {
  const res = await apiFetch('/api/_internal/sub-processors')
  expect(res.status).toBe(200)
})

test('privacy page mounts in the browser', async ({ page }) => {
  const res = await page.goto('/legal/privacy')
  expect(res?.status() ?? 500, 'privacy page HTTP status').toBeLessThan(400)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
})
