import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'
import { Pool } from 'pg'

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

  /** Connection status badge with status='connected'. Drives waitForReady
   *  and works on both mobile (icon-only) and desktop (icon + label). */
  get connectedBadge(): Locator {
    return this.page.locator('[data-testid="connection-status"][data-status="connected"]')
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

  // ─── AI surfaces ──────────────────────────────────────────────────
  //
  // Two interaction surfaces for the AI assistant:
  //   1. The floating prompt bar at the bottom of the editor — always
  //      visible when the viewer is logged in. Send a prompt → AI
  //      runs an agentic loop and edits the doc directly.
  //   2. The @ai mention inside a comment thread — typing @ai in any
  //      comment composer opens the typeahead with the synthetic AI
  //      entry; posting the comment fires `/trigger-ai` and the AI
  //      reply lands as a reply on the same thread.
  //
  // Both surfaces drive the SAME backend (one agentic loop, same
  // tools), but the UI affordances are distinct so flow tests need
  // both selector groups.

  get ai() {
    return {
      /** The floating AI prompt bar root. `data-active` flips to "true"
       *  while a session is in flight — gates "wait until AI started" /
       *  "wait until AI finished" steps. */
      promptBar: this.page.locator('[data-testid="ai-prompt-bar"]'),
      /** The text input inside the prompt bar. */
      promptBarInput: this.page.locator('[data-testid="ai-prompt-bar-input"]'),
      /** The send button (paper-airplane icon when idle). Disabled
       *  until the input has a non-empty trimmed value. */
      promptBarSend: this.page.locator('[data-testid="ai-prompt-bar-send"]'),
      /** The synthetic AI entry in the comment-composer mention typeahead. */
      mentionTypeaheadAi: this.page.locator('[data-testid="mention-typeahead-ai"]'),
      /** Any comment thread currently rendering its "AI is responding"
       *  active state. Useful for waiting on the AI-trigger handshake. */
      activeThread: this.page.locator('[data-testid="comment-thread"][data-ai-active="true"]')
    }
  }

  /**
   * Wait for the AI prompt bar to flip back to idle. Used after a
   * prompt to gate "the AI is done" — checks `data-active=false`,
   * which is set by the bottom-bar component when the
   * useAI().mySession ref clears (status='done' or session aborted).
   *
   * Default 90s because real Gemini turns can take 5-30s and a
   * multi-tool loop chains several. Override for fast prompts.
   */
  async waitForAiIdle(timeout = 90_000): Promise<void> {
    await expect(this.ai.promptBar).toHaveAttribute('data-active', 'false', { timeout })
  }

  /**
   * Wait for the AI prompt bar to enter the "session active" state —
   * confirms the agentic loop actually started server-side and the
   * client received the `/api/ai/prompt` response. Use this BEFORE
   * `waitForAiIdle` so flaky network conditions are caught at the
   * "didn't start" boundary, not the "didn't finish" one.
   */
  async waitForAiActive(timeout = 30_000): Promise<void> {
    await expect(this.ai.promptBar).toHaveAttribute('data-active', 'true', { timeout })
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
   * Wait for the preview iframe to finish pagination. paged.js
   * creates `.pagedjs_pages` early (empty, hidden) and only appends
   * `.pagedjs_page` children when pagination actually completes —
   * waiting on the inner `.pagedjs_page` is the reliable signal.
   * Screenshots taken before that show a blank preview pane.
   */
  async waitForPreviewPaginated(timeout = 15_000): Promise<void> {
    await this.page
      .frameLocator('iframe')
      .locator('.pagedjs_page')
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

  // ─── Auth (TEST_MODE only) ────────────────────────────────────────

  /**
   * Seal a session cookie for a fresh test user. Uses the
   * `/api/_test/login` shim that's only mounted when the Nuxt
   * subprocess was started with TEST_MODE=1 — the flow-ephemeral
   * orchestrator sets this for us.
   *
   * Two-step:
   *   1. INSERT a `users` row via direct pg (the login shim takes a
   *      userId and assumes the row exists; without this AI flows
   *      404 when the prompt handler resolves the user).
   *   2. POST to /api/_test/login → response sets a sealed session
   *      cookie on the page context.
   *
   * Returns the user id so callers can use it (e.g. for billing
   * resolution checks).
   */
  async loginAsTestUser(name: string): Promise<{ userId: number, name: string }> {
    // Postgres lives at the ephemeral test stack's port (5433). The
    // pool stays open per test for ~25ms total work; closing it after
    // every login would force a fresh TCP handshake on every flow.
    const pool = new Pool({
      connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
      max: 1
    })
    try {
      const githubId = `flow-test-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
      const result = await pool.query<{ id: number }>(
        `INSERT INTO users (github_id, name, plan)
         VALUES ($1, $2, 'free')
         ON CONFLICT (github_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [githubId, name]
      )
      const userId = result.rows[0].id

      // Seal the session via the shim. We use Node's `fetch` rather
      // than `page.request.post` because the latter goes through
      // Playwright's CDP-bridged BrowserContext and tries to attach
      // returned Set-Cookie headers to a context that hasn't loaded
      // any origin yet — that path threw `TypeError: "/..." cannot
      // be parsed as a URL` even when the actual POST succeeded.
      // Going through `fetch` + `addCookies` avoids the BrowserContext
      // round-trip entirely; we just parse the Set-Cookie header and
      // tell Playwright "this cookie applies to this origin".
      const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
      const res = await fetch(`${baseUrl}/api/_test/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, name })
      })
      if (!res.ok) {
        throw new Error(`[loginAsTestUser] /api/_test/login returned ${res.status}: ${await res.text()}`)
      }
      const setCookie = res.headers.get('set-cookie')
      if (!setCookie) {
        throw new Error(`[loginAsTestUser] /api/_test/login returned no Set-Cookie header`)
      }
      // Parse the cookie just enough to feed it to addCookies. The
      // shim only emits `nuxt-session=<sealed-blob>; Path=/; ...`
      // — name and value are everything before the first `;` and
      // before/after the first `=`.
      const firstChunk = setCookie.split(';')[0]
      const eqIdx = firstChunk.indexOf('=')
      const cookieName = firstChunk.slice(0, eqIdx)
      const cookieValue = firstChunk.slice(eqIdx + 1)
      await this.page.context().addCookies([{
        name: cookieName,
        value: cookieValue,
        url: baseUrl,
        httpOnly: true,
        sameSite: 'Lax'
      }])
      return { userId, name }
    } finally {
      await pool.end()
    }
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
