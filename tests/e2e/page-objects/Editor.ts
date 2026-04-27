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
      knowledge: this.page.getByRole('button', { name: /knowledge/i, exact: true }),
      comments: this.page.locator('[data-testid="comments-tab-toggle"]')
    }
  }

  // ─── Comments panel + composer ────────────────────────────────────
  //
  // Surface area large enough that grouping it under a `comments` getter
  // keeps the flow tests readable. All selectors go through testids so
  // i18n changes don't drift.

  get comments() {
    return {
      /** The floating "Add comment" pill that appears when text is selected. */
      selectionPopupTrigger: this.page.locator('[data-testid="comment-selection-popup-trigger"]'),
      /** The composer textarea (NEW COMMENT or any reply box). */
      composerInput: this.page.locator('[data-testid="comment-composer-input"]'),
      /** The submit button next to the composer. */
      composerSubmit: this.page.locator('[data-testid="comment-composer-submit"]'),
      /** Any comment thread card in the panel. Filter by hasText for a specific one. */
      thread: this.page.locator('[data-testid="comment-thread"]'),
      /** The "Show resolved" toggle in the panel header. */
      showResolvedToggle: this.page.locator('[data-testid="comments-show-resolved-toggle"]'),
      /** The "Resolved" section heading; visible iff showResolved is on AND there are resolved threads. */
      resolvedSectionHeading: this.page.locator('[data-testid="comments-resolved-section-heading"]'),
      /**
       * Get the Delete button inside a specific thread (scoped by id or
       * by visible text). Tests should prefer scoping by the thread's
       * `data-comment-id` (stable) over body text (i18n-fragile, though
       * comments aren't translated).
       */
      deleteIn: (thread: Locator): Locator => thread.locator('[data-testid="comment-action-delete"]').first(),
      resolveIn: (thread: Locator): Locator => thread.locator('[data-testid="comment-action-resolve"]'),
      unresolveIn: (thread: Locator): Locator => thread.locator('[data-testid="comment-action-unresolve"]')
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

  // ─── New-document dialog ──────────────────────────────────────────

  /** Selectors inside the new-document dialog. The dialog opens when
   *  the user clicks "+ New Document" anywhere — homepage, workspace,
   *  or File menu. Five questions: title, description, language,
   *  audience, theme, template. Two submit paths: `submitCreate` (full
   *  form) and `submitBlank` ("Just give me a blank doc").
   *
   *  All selectors go through `data-testid` rather than IDs / role +
   *  text, so they (a) survive i18n changes, (b) don't accidentally
   *  match the homepage's "+ New Document" button, and (c) survive any
   *  Nuxt UI markup change that doesn't alter the testid. */
  get newDocDialog() {
    return {
      heading: this.page.getByRole('heading', { name: /^new document$/i }),
      titleInput: this.page.locator('[data-testid="newdoc-title-input"]'),
      descriptionInput: this.page.locator('[data-testid="newdoc-description-input"]'),
      languageInput: this.page.locator('[data-testid="newdoc-language-input"]'),
      audienceSelect: this.page.locator('[data-testid="newdoc-audience-select"]'),
      // Each card has its own testid keyed by id (`newdoc-template-card-recipe`,
      // `newdoc-theme-card-modern`, etc.). Cleaner + faster than text matching.
      templateCard: (id: string) => this.page.locator(`[data-testid="newdoc-template-card-${id}"]`),
      themeCard: (id: string) => this.page.locator(`[data-testid="newdoc-theme-card-${id}"]`),
      submitCreate: this.page.locator('[data-testid="newdoc-submit-create"]'),
      submitBlank: this.page.locator('[data-testid="newdoc-submit-blank"]'),
      cancel: this.page.locator('[data-testid="newdoc-cancel"]')
    }
  }

  /**
   * Wait for the new-document dialog to be open + ready for input.
   * Use after clicking a "+ New Document" button to gate subsequent
   * dialog interactions on the modal's mount.
   */
  async waitForNewDocDialog(timeout = 15_000): Promise<void> {
    // 15s default: cross-project runs (e.g. en-dark right after
    // en-light) can take longer to first-paint the dialog because the
    // dev subprocess is shared but Playwright contexts are fresh, so
    // the second project pays a hydration tax. Individual-project
    // runs typically resolve in <1s; the wide timeout only kicks in
    // on cold-context boots.
    await expect(this.newDocDialog.heading).toBeVisible({ timeout })
    await expect(this.newDocDialog.titleInput).toBeVisible()
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
   * Wait for the preview iframe to finish pagination. paged.js mounts
   * `.pagedjs_pages` once it's done laying out the doc — until then
   * the preview pane is blank. Screenshots taken before that show a
   * meaningless empty pane. Use after switchToSplitView() (or any
   * mode change that exposes the preview) before capturing the first
   * preview-bearing shot.
   */
  async waitForPreviewPaginated(timeout = 15_000): Promise<void> {
    await this.page
      .frameLocator('iframe')
      .locator('.pagedjs_pages')
      .first()
      .waitFor({ state: 'visible', timeout })
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
