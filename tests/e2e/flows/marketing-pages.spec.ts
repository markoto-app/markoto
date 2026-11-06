import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/flow'

// Smoke flow for the hosted marketing site (`@marketing`): the pages a
// visitor reaches before opening the editor render, with the site header
// that only the marketing site shows (Self-host link) and its footer columns.
//
// `@marketing` = runs only in the marketing pass of
// scripts/flows-ephemeral.ts, against a server with
// NUXT_MARKETING_SITE_ENABLED=true. The marketing pages are 404 on every
// other server, and the default pass keeps the site off.
//
// No docs page embeds this flow, so scripts/build-flows.ts never
// publishes it: it is regression coverage for the marketing pass.
// Desktop and mobile: on phones Self-host leaves the header for the footer.

/**
 * The marketing site's header stays short (Pricing, Self-host from `sm`,
 * Docs — no menus); the use-case, comparison and template pages are in
 * the footer's columns.
 */
async function expectMarketingHeader(page: Page, isMobile: boolean): Promise<void> {
  const header = page.locator('header.mk-site-header')
  await expect(header).toBeVisible()
  await expect(header.getByTestId('header-pricing-link')).toBeVisible()
  await expect(header.getByTestId('header-docs-link')).toBeVisible()
  if (isMobile) await expect(header.getByTestId('header-self-host-link')).toBeHidden()
  else await expect(header.getByTestId('header-self-host-link')).toBeVisible()
  await expect(header.getByRole('link', { name: 'Markdown cheat sheet' })).toHaveCount(0)
  const footer = page.getByTestId('legal-footer')
  await expect(footer.getByTestId('footer-col-use-cases').getByRole('link', { name: 'Markdown cheat sheet' })).toBeAttached()
  await expect(footer.getByTestId('footer-col-compare')).toBeAttached()
}

test('Marketing pages', { tag: '@marketing' }, async ({ page, flow, editor }) => {
  test.setTimeout(90_000)

  await flow.heading('The Markdown cheat sheet', 3)
  await page.goto('/markdown-cheat-sheet')
  // ASSERTION: the content page renders (not the 404 the catch-all
  // answers off the marketing site), in English, with its heading.
  const article = page.getByTestId('marketing-page')
  await expect(article).toBeVisible()
  await expect(article).toHaveAttribute('lang', 'en')
  await expect(article.getByRole('heading', { level: 1, name: 'Markdown cheat sheet' })).toBeVisible()
  await expectMarketingHeader(page, editor.isMobile)
  await flow.shot('The cheat sheet: every Markdown example next to its result.', {
    hero: true,
    highlights: [{ label: 'site menu', selector: 'header.mk-site-header' }]
  })

  await flow.heading('Pricing', 3)
  await page.goto('/pricing')
  // ASSERTION: the options layout of the hosted site, same header.
  await expect(page.getByTestId('pricing-option-self-hosted')).toBeVisible()
  await expect(page.getByTestId('pricing-tier-free')).toBeVisible()
  await expectMarketingHeader(page, editor.isMobile)
  await flow.shot('Pricing: self-hosted, no account, a free account and the planned paid plans.')
})
