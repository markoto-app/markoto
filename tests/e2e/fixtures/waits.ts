/* eslint-disable playwright/no-wait-for-timeout --
   The only place a fixed sleep is allowed. Each helper names the reason a condition wait cannot replace it, so
   call sites say WHY they wait instead of carrying a bare number. */
import type { Page } from '@playwright/test'

/**
 * Let the sync server flush what was typed so far as its own batch.
 *
 * Hocuspocus debounces stores by 2 s (`debounce: 2000` in `sync-server/src/index.ts`) and an activity row is
 * created per stored batch. Polling cannot help: it would exit at flush time while the next keystroke can
 * still land in the same batch, collapsing two edits into one row. 3 s = the debounce + 1 s safety.
 */
export async function waitForSyncDebounce(page: Page, ms = 3_000): Promise<void> {
  await page.waitForTimeout(ms)
}

/**
 * Wait out a CSS transition / layout settle before a screenshot or the next click.
 *
 * There is no DOM state that says "the transition has finished": an element can be visible and attached
 * while it is still sliding, and a screenshot taken then differs from run to run.
 */
export async function settleAnimations(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}

/**
 * Give an event that must NOT cause anything a chance to (wrongly) do so before asserting the absence.
 *
 * A condition wait cannot observe "nothing happened"; the window has to elapse.
 */
export async function waitForNothingToHappen(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}

/**
 * Keep a pointer (a finger, a dragged item) where it is for `ms`.
 *
 * A long press is defined by how long the finger stays down, and a drop target sees a dragged item only after the
 * browser has delivered `dragover` to it: in both cases time has to pass with nothing on the page to wait for.
 */
export async function holdPointer(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}
