import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/flow'

// Smoke flow for the hosted marketing site (`@marketing`): the pages a
// visitor reaches before opening the editor render, with the site header
// that only the marketing site shows (Use cases menu, Self-host link).
//
// `@marketing` = runs only in the marketing pass of
// scripts/flows-ephemeral.ts, against a server with
// NUXT_MARKETING_SITE_ENABLED=true. The marketing pages are 404 on every
// other server, and the default pass keeps the site off.
//
// No docs page embeds this flow, so scripts/build-flows.ts never
// publishes it: it is regression coverage for the marketing pass.
// Desktop and mobile: on phones the header links move into one menu.

/** The marketing site's header: Self-host link + Use cases menu (inline from `lg`, in the menu below). */
async function expectMarketingHeader(page: Page, isMobile: boolean): Promise<void> {
  const header = page.locator('header.mk-site-header')
  await expect(header).toBeVisible()
  if (isMobile) {
    // The page paints from the server render before it hydrates (the
    // marketing pages ship without modulepreload hints), so a click right
    // after `load` can land before the menu's handler is attached: retry
    // until the menu is open (same pattern as silentSetup).
    await expect(async () => {
      await header.getByTestId('header-menu').click()
      await expect(page.getByRole('menuitem', { name: 'Self-host' })).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15_000 })
    await expect(page.getByRole('menuitem', { name: 'Markdown cheat sheet' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Self-host' })).toHaveCount(0)
  } else {
    await expect(header.getByTestId('header-self-host-link')).toBeVisible()
    await expect(header.getByTestId('header-use-cases')).toBeVisible()
  }
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
