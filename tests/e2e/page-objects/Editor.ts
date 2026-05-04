import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'
import { Pool } from 'pg'
import { TESTID, sel } from '../../../shared/testids'

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

  /** Connection status chip — ONLY rendered when status is `connecting`
   *  or `disconnected`. Connected is the assumed default and the chip
   *  is hidden (see EditorLayout.vue's `v-if="status !== 'connected'"`).
   *  Tests should wait for this locator to be DETACHED (= connected),
   *  not visible. The historical `connectedBadge` was based on the
   *  always-rendered chip; that surface was removed in the topbar
   *  polish pass. */
  get nonConnectedBadge(): Locator {
    return this.page.locator('[data-testid="connection-status"]')
  }

  /** The access-mode lock icon in the header (opens share dialog on click). */
  get accessLockButton(): Locator {
    return this.page.locator(sel(TESTID.ACCESS_LOCK_BUTTON))
  }

  // ─── View-mode toggle group ───────────────────────────────────────

  /** The three view-mode buttons in the header center. Selected by
   *  `data-testid="view-mode-{edit,split,preview}"` from
   *  EditorLayout.vue — text-based lookups would clash with the
   *  menubar's "Edit" menu (same accessible name). */
  get viewMode() {
    return {
      edit: this.page.locator(sel(TESTID.VIEW_MODE_EDIT)),
      split: this.page.locator(sel(TESTID.VIEW_MODE_SPLIT)),
      preview: this.page.locator(sel(TESTID.VIEW_MODE_PREVIEW))
    }
  }

  // ─── Right-sidebar toggles ────────────────────────────────────────

  get sidebar() {
    return {
      document: this.page.locator(sel(TESTID.SIDEBAR_TAB_DOCUMENT)),
      comments: this.page.locator(sel(TESTID.SIDEBAR_TAB_COMMENTS)),
      activity: this.page.locator(sel(TESTID.SIDEBAR_TAB_ACTIVITY)),
      theme: this.page.locator(sel(TESTID.SIDEBAR_TAB_THEME)),
      knowledge: this.page.locator(sel(TESTID.SIDEBAR_TAB_KNOWLEDGE))
    }
  }

  // ─── Theme panel ──────────────────────────────────────────────────
  //
  // Surface area for the right-sidebar theme editor. Preset cards have
  // stable `theme-preset-{id}` testids; the cover-page accordion's
  // master toggle has `theme-cover-enabled-switch`. Section headers
  // (the `<UAccordion>` triggers) are matched by visible label —
  // they're translated, but every locale tested today (en) shares the
  // same English label set.
  get theme() {
    return {
      /** Click a preset card to apply that preset wholesale. */
      preset: (id: string): Locator =>
        this.page.locator(`[data-testid="theme-preset-${id}"]`),
      /** The cover-page accordion section header. Click to expand. */
      coverSection: this.page.getByRole('button', { name: /cover page/i }).first(),
      /** Toggle that turns the cover page on/off when the section is expanded. */
      coverEnabledSwitch: this.page.locator(
        '[data-testid="theme-cover-enabled-switch"]'
      )
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

  // ─── Live dictation ───────────────────────────────────────────────
  //
  // The toolbar mic toggles streaming dictation (`/api/ai/dictate` WS).
  // Mobile surfaces the same control as the second tab on the bottom
  // MobileTabBar (`data-testid="mobile-tab-dictate"`). The toolbar
  // mic doesn't currently have a stable testid; match by aria-label
  // ("Start dictation" / "Stop dictation" — both states resolve so a
  // tooltip-text regex catches either).

  /** The toolbar dictation mic. `data-testid` is stable; `aria-label`
   *  flips between "Start dictation" and "Stop dictation"; the
   *  `data-active` attribute is `'true'` when the dictation state is
   *  busy or recording — useful for waiting on state transitions. */
  get dictateMicButton(): Locator {
    return this.page.locator('[data-testid="toolbar-dictate-mic"]')
  }

  /** Mobile tab-bar dictation tab — only visible at <sm width. */
  get dictateMobileTab(): Locator {
    return this.page.locator('[data-testid="mobile-tab-dictate"]')
  }

  /** Mobile bottom-bar tabs. The aria-labels come from the
   *  `mobileTabBar.*Short` i18n keys (en):
   *    Editor / Dictate / Info / Comments / Activity / Theme / Knowledge
   *  Note "Info" is the label for the Document panel — the short
   *  i18n key is `documentShort` but the rendered text is "Info".
   *  The Knowledge tab only renders when `hasKnowledgeAccess` is
   *  true (workspace doc with ≥1 ready file). */
  get mobileTabs() {
    return {
      editor: this.page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Editor"]'),
      document: this.page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Info"]'),
      comments: this.page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Comments"]'),
      activity: this.page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Activity"]'),
      theme: this.page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Theme"]'),
      knowledge: this.page.locator('[data-testid="mobile-tab-bar"] button[aria-label="Knowledge"]')
    }
  }

  /**
   * Disable the cover page on the current document so the preview
   * iframe shows page 1 = inserted/dictated/AI-generated content,
   * not the cover sheet. The markoto theme ships with
   * `cover.enabled: true` by default — every new doc has a title
   * page that hides the actual body in the preview pane until the
   * reader scrolls or pages forward.
   *
   * Requires the current actor to be logged in: PUT /api/docs/:id/meta
   * is gated on `canEdit` which goes through `requireValidatedUserSession`.
   * Anonymous flows that need preview visibility should call
   * `loginAsTestUser()` before `silentSetup()` AND this helper after.
   *
   * Implementation: PUT /meta with the FULL `defaultTheme` schema
   * with `cover.enabled` flipped to false. We can't merge a partial
   * over the GET-returned `theme` JSONB because the column may hold
   * a partial (or null) and `isValidTheme` requires every field
   * present. The default theme IS the markoto preset's full shape —
   * sending it back unchanged-except-cover gives the same visual
   * result the user gets when they toggle the cover switch in the
   * theme panel. paged.js repaginates ~500 ms after Y.js broadcasts
   * the new theme; we wait 800 ms so the next captured screenshot
   * lands on a settled preview.
   */
  async disableCoverPage(): Promise<void> {
    const url = new URL(this.page.url())
    const m = url.pathname.match(/\/d\/([^/?]+)/)
    if (!m) throw new Error(`[disableCoverPage] not on a /d/{id} route, got ${url.pathname}`)
    const docId = m[1]

    // Import the default theme via dynamic import to avoid pulling
    // shared/utils into the page-object module graph at top level.
    // Use a relative path — Playwright's TS resolver doesn't honour
    // the `~~` alias from the Nuxt tsconfig.
    const { defaultTheme } = await import('../../../shared/utils/defaultTheme')
    // Spread on `cover` keeps every other cover sub-field
    // (showSubtitle / layout / dateFormat etc.) at its default while
    // flipping `enabled` off.
    const newTheme = {
      ...defaultTheme,
      cover: { ...defaultTheme.cover, enabled: false }
    }

    const putRes = await this.page.request.put(`/api/docs/${docId}/meta`, {
      data: { theme: newTheme }
    })
    if (!putRes.ok()) {
      throw new Error(`[disableCoverPage] PUT /meta returned ${putRes.status()}: ${await putRes.text()}`)
    }
    await this.page.waitForTimeout(800)
  }

  /**
   * Switch the current doc's access mode via PUT /meta. Useful for
   * collab + read-only-share flows where a logged-in owner creates
   * a private doc by default and a spawned visitor needs reach in.
   *
   * Modes: `private` | `open-edit` | `open-view` | `password-protected`.
   * (`password-protected` here only flips the mode; setting the
   * actual passphrase still goes through the share modal so the
   * password-protect flow's narration stays honest.)
   */
  async setAccessMode(mode: 'private' | 'open-edit' | 'open-view' | 'password-protected'): Promise<void> {
    const url = new URL(this.page.url())
    const m = url.pathname.match(/\/d\/([^/?]+)/)
    if (!m) throw new Error(`[setAccessMode] not on a /d/{id} route, got ${url.pathname}`)
    const docId = m[1]
    const putRes = await this.page.request.put(`/api/docs/${docId}/meta`, {
      data: { accessMode: mode }
    })
    if (!putRes.ok()) {
      throw new Error(`[setAccessMode] PUT /meta returned ${putRes.status()}: ${await putRes.text()}`)
    }
    await this.page.waitForTimeout(300)
  }

  /** EditorCommandsPanel buttons (mobile drawer content). */
  get mobileEditorCommands() {
    return {
      import: this.page.locator('[data-testid="ecp-file-import"]'),
      exportPdf: this.page.locator('[data-testid="ecp-file-export-pdf"]'),
      exportMd: this.page.locator('[data-testid="ecp-file-export-md"]')
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
   * handshake completed.
   *
   * The connection-status chip is now hidden when status === 'connected'
   * (topbar polish pass), so we can't wait for it to APPEAR. Instead:
   *   1. Wait for the title button to render (markup hydrated +
   *      ymeta has produced an initial title — implies the doc Y.Doc
   *      is bound).
   *   2. Wait for any non-connected chip (`connecting` / `disconnected`)
   *      to be detached. If the chip is gone, we're connected. The
   *      detached check tolerates the chip never appearing (a fast
   *      handshake can skip the `connecting` state entirely).
   */
  async waitForReady(timeout = 15_000): Promise<void> {
    await expect(this.titleButton).toBeVisible({ timeout })
    // toHaveCount(0) is the "no non-connected chip exists" check —
    // succeeds either if the chip rendered then vanished (connect
    // resolved) or if it never rendered at all (handshake was fast
    // enough to skip `connecting`).
    await expect(this.nonConnectedBadge).toHaveCount(0, { timeout })
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
      await this.loginAsExistingUser(userId, name)
      return { userId, name }
    } finally {
      await pool.end()
    }
  }

  /**
   * Seal a session for an ALREADY-EXISTING user row. The sibling of
   * `loginAsTestUser`, but for cases where the user row was created
   * by other means — typically a direct DB INSERT in the spec to set
   * fields the login shim doesn't expose (email, plan='max', custom
   * github_id matching a pre-stored invitation, etc.).
   *
   * Why split: `loginAsTestUser` always upserts a fresh user keyed on
   * a name+timestamp `github_id`. Two-context flows where one context
   * needs to log in as a SPECIFIC pre-created user (e.g. the invited
   * teammate in `invite-a-teammate`) couldn't reuse it without the
   * `Date.now()`-suffixed id forcing a different row. Extracting the
   * cookie-sealing portion lets the spec INSERT the user with the
   * exact shape it needs, then call this helper to seal a session
   * against that id.
   *
   * Same fetch + addCookies dance as `loginAsTestUser` (see that
   * method for the rationale on why we go through Node fetch instead
   * of Playwright's `page.request.post`).
   */
  async loginAsExistingUser(userId: number, name: string): Promise<void> {
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/_test/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, name })
    })
    if (!res.ok) {
      throw new Error(`[loginAsExistingUser] /api/_test/login returned ${res.status}: ${await res.text()}`)
    }
    const setCookie = res.headers.get('set-cookie')
    if (!setCookie) {
      throw new Error(`[loginAsExistingUser] /api/_test/login returned no Set-Cookie header`)
    }
    const firstChunk = setCookie.split(';')[0]
    const eqIdx = firstChunk.indexOf('=')
    await this.page.context().addCookies([{
      name: firstChunk.slice(0, eqIdx),
      value: firstChunk.slice(eqIdx + 1),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax'
    }])
  }

  // ─── Navigation ───────────────────────────────────────────────────

  /**
   * Go to homepage, click "New Document", wait for redirect to /d/{id}.
   * Does NOT wait for the WS handshake — call waitForReady() after.
   * Split lifecycle from waitForReady so callers can record the
   * redirect as a separate step in the manifest if they want.
   *
   * **ANONYMOUS USERS ONLY.** A logged-in user clicking "+ New Document"
   * opens the new-doc dialog instead of navigating directly — call
   * `openNewDocDialog()` for that path and submit the dialog yourself.
   * Calling this from a logged-in test wedges Playwright on the
   * `waitForURL` race for 120 s before the test timeout fires.
   */
  async createNewDoc(): Promise<void> {
    await this.page.goto('/')
    await expect(this.page.locator('[data-testid="landing-new-document"]')).toBeVisible()
    await Promise.all([
      this.page.waitForURL(/\/d\/[^/]+/),
      this.page.locator('[data-testid="landing-new-document"]').click()
    ])
  }

  /**
   * LOGGED-IN equivalent of `createNewDoc`. Opens the homepage, clicks
   * "+ New Document", waits for the new-doc dialog to render. Returns
   * with the dialog open and the title input visible — callers fill
   * the form and submit themselves.
   *
   * Uses the same Vue-hydration retry pattern as `silentSetup`/
   * `recordPreamble` (an `expect.toPass` loop) — the SSR'd button
   * looks interactive before its `@click` handler attaches, so a
   * single click can be a no-op. Retries until the dialog heading
   * is visible.
   */
  async openNewDocDialog(): Promise<void> {
    await this.page.goto('/')
    const btn = this.page.locator('[data-testid="landing-new-document"]')
    await btn.waitFor({ state: 'visible' })
    await expect(async () => {
      await btn.click()
      await expect(this.newDocDialog.heading).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15_000 })
    await expect(this.newDocDialog.titleInput).toBeVisible()
  }

  /**
   * One-shot for logged-in flows that want a doc with a title: open
   * the dialog, type the title, submit via the `Create` button
   * (NOT `Skip` / `submitBlank` — the blank-submit path skips the
   * form fields and produces an "Untitled" doc).
   *
   * **Why pressSequentially instead of fill():** Nuxt UI's UInput is
   * a wrapper component; the `data-testid` lives on its outer shell.
   * Playwright's `.fill()` works against it (the locator auto-finds
   * the inner input) but doesn't always trigger Vue's v-model sync
   * before the next click — the form submits with an empty `title`
   * and the doc is "Untitled". Per-keystroke events from
   * `pressSequentially()` mirror real user input and reliably commit
   * to the v-model before submit.
   */
  async createBlankDocWithTitle(title: string): Promise<void> {
    await this.openNewDocDialog()
    await this.newDocDialog.titleInput.click()
    await this.newDocDialog.titleInput.pressSequentially(title)
    // Belt-and-braces: wait until the input ECHOES the typed value
    // before clicking submit. Guards against v-model-not-yet-synced
    // races that produced "Untitled" docs.
    await expect(this.newDocDialog.titleInput).toHaveValue(title)
    await Promise.all([
      this.page.waitForURL(/\/d\/[^/]+/),
      this.newDocDialog.submitCreate.click()
    ])
    await this.waitForReady()
  }
}
