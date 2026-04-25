import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'

// Page-object for the YPad editor (`/d/<id>`). Stable selectors for
// the parts of the UI that flow tests touch most often. ONE place to
// fix when the markup changes — flow tests stay declarative.
//
// Selector strategy, in order of preference:
//   1. data-testid (won't drift with translations)
//   2. getByRole + accessible name (when the button has a real label)
//   3. structural locator (last resort; flag with a comment)
//
// Adding new helpers: prefer composing existing getters over repeating
// selector strings. Each helper should do one user-visible thing
// (`startTitleEdit`, not `clickTitleAndWaitForFocus`).

export class EditorPage {
  constructor(public readonly page: Page) {}

  // ─── Header / title ───────────────────────────────────────────────

  /** The title button shown when NOT editing. Click to enter edit mode. */
  get titleButton(): Locator {
    return this.page.locator('[data-testid="doc-title-button"]')
  }

  /** The title input shown WHILE editing. Auto-focused on click; auto-selects all. */
  get titleInput(): Locator {
    return this.page.locator('[data-testid="doc-title-input"]')
  }

  /** "Connected" badge inside the header. Visible once the WS handshake completes. */
  get connectedBadge(): Locator {
    return this.page.locator('header').getByText('Connected')
  }

  /** The access-mode lock icon in the header (opens share dialog on click). */
  get accessLockButton(): Locator {
    return this.page.getByRole('button', { name: /access mode/i })
  }

  // ─── View-mode toggle group ───────────────────────────────────────

  /** The three view-mode buttons in the header center. */
  get viewMode() {
    return {
      edit: this.page.getByRole('button', { name: /^edit$/i }),
      split: this.page.getByRole('button', { name: /split view/i }),
      preview: this.page.getByRole('button', { name: /^preview$/i })
    }
  }

  // ─── Right-sidebar toggles ────────────────────────────────────────

  get sidebar() {
    return {
      activity: this.page.getByRole('button', { name: /activity/i, exact: true }),
      theme: this.page.getByRole('button', { name: /theme/i, exact: true }),
      knowledge: this.page.getByRole('button', { name: /knowledge/i, exact: true })
    }
  }

  // ─── Status bar (footer) ──────────────────────────────────────────

  get statusBar() {
    return {
      wordCount: this.page.locator('[data-testid="word-count"]'),
      charCount: this.page.locator('[data-testid="char-count"]'),
      pageCount: this.page.locator('[data-testid="page-count"]'),
      syncStatus: this.page.locator('[data-testid="sync-status"]')
    }
  }

  // ─── Composite actions ────────────────────────────────────────────

  /**
   * Wait until the editor has fully mounted AND the Hocuspocus WS
   * handshake completed. The "Connected" badge is the cheapest signal
   * we have for both. Title button being visible is a secondary
   * mount-completed signal — guards against the badge appearing
   * before the editor markup hydrated.
   */
  async waitForReady(timeout = 15_000): Promise<void> {
    await expect(this.connectedBadge).toBeVisible({ timeout })
    await expect(this.titleButton).toBeVisible()
  }

  /**
   * Switch to split view (editor + live preview side-by-side). New
   * docs land in preview mode briefly while `isReadOnly` resolves —
   * calling this puts you in the most useful mode for screenshots.
   */
  async switchToSplitView(): Promise<void> {
    await this.viewMode.split.click()
    await expect(this.viewMode.split).toHaveClass(/bg-primary/)
  }

  /**
   * Click the title button to enter rename mode. Waits until the
   * input element is focused before returning, so the next keystroke
   * is guaranteed to land in the input (not the editor).
   */
  async startTitleEdit(): Promise<void> {
    await this.titleButton.click()
    await expect(this.titleInput).toBeFocused()
  }

  /**
   * Type the new title and commit it. Assumes startTitleEdit was just
   * called. Uses pressSequentially (per-keystroke events) which
   * matches user behaviour and is what triggers the Y.js title bridge.
   * Waits for the input to be replaced with the saved-title button
   * before returning — guards against capturing mid-blur state.
   */
  async commitTitleEdit(newTitle: string): Promise<void> {
    await this.titleInput.pressSequentially(newTitle)
    await this.page.keyboard.press('Enter')
    await expect(this.titleButton.filter({ hasText: newTitle })).toBeVisible()
  }

  // ─── Navigation ───────────────────────────────────────────────────

  /**
   * Go to homepage, click "New Document", wait for redirect to /d/{id}.
   * Does NOT wait for the WS handshake — call waitForReady() after.
   * Split lifecycle from waitForReady so callers can record the
   * redirect as a separate step in the manifest if they want.
   */
  async createNewDoc(): Promise<void> {
    await this.page.goto('/')
    await expect(this.page.getByRole('button', { name: /new document/i })).toBeVisible()
    await Promise.all([
      this.page.waitForURL(/\/d\/[^/]+/),
      this.page.getByRole('button', { name: /new document/i }).click()
    ])
  }
}
