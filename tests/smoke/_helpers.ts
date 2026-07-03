import { expect, type Page } from '@playwright/test'

// API calls use the runtime's global `fetch`, NOT Playwright's `request`
// fixture. Under Bun, the `request` fixture throws while parsing the
// response's Set-Cookie header against the URL ("cannot be parsed as a URL")
// even though the HTTP call itself succeeds — a Playwright-under-Bun quirk.
// Global fetch with an absolute URL sidesteps it entirely and is all the
// smoke suite needs (stateless, anonymous). Page navigations still use the
// `page` fixture with the config's baseURL.
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://staging.markoto.app'

export function api(path: string): string {
  return new URL(path, BASE_URL).toString()
}

/**
 * Create an anonymous document via the public API and return its id.
 * Anonymous doc creation is a first-class flow (login is optional), so the
 * smoke suite needs no auth. Optional body carries new-doc-dialog fields
 * (templateId / language / audience / description).
 */
export async function createAnonDoc(body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(api('/api/docs'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  expect(res.status, `POST /api/docs → ${res.status}: ${text.slice(0, 200)}`).toBeLessThan(300)
  const json = JSON.parse(text) as { docId?: string }
  expect(json.docId, 'docId in create response').toBeTruthy()
  return json.docId!
}

/**
 * Dismiss the cookie-consent banner if present. It's `fixed bottom-0 z-[60]`,
 * so on a fresh anonymous context it sits OVER the mobile bottom tab bar
 * (z-30) and blocks taps on it. Reject-all is the privacy-preserving choice.
 * No-op if the banner isn't showing (consent already recorded).
 */
export async function dismissConsent(page: Page): Promise<void> {
  const reject = page.locator('[data-testid="consent-reject-all"]')
  if (await reject.isVisible().catch(() => false)) {
    await reject.click()
    await page.locator('[data-testid="consent-banner"]')
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => { /* banner animates out; detachment is best-effort */ })
  }
}
