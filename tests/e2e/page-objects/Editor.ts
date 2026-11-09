import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'
import { Pool } from 'pg'
import { TESTID, sel } from '../../../shared/testids'
import { PRIVACY_VERSION, TOS_VERSION, DPA_VERSION } from '../../../shared/legal/versions'

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
   * Default 240s. Real Mistral turns are 5-30s; a multi-tool loop
   * (fetch_url's 2-call sub-pipeline + surrounding agentic turns) chains
   * 4-6 of them. The LiteLLM wrapper retries 429s with up to 45s of
   * cumulative backoff per call (3s + 6s + 12s + 24s — see
   * `server/utils/litellm/createCompletion.ts`), sized to ride out a
   * full Mistral per-minute rate-limit window. Worst case for a
   * 4-call loop hitting sustained throttling: ~30s × 4 + ~45s × 1 retry
   * burst ≈ 165s. 240s = ~50% headroom on top.
   *
   * Override downward for single-prompt flows where the savings matter
   * (the test still aborts on real 5-min server-side deadline). Override
   * upward (e.g. `300_000`) for AI flows that genuinely chain many
   * tools — `ai-comment-mention` already does this via its own
   * `test.setTimeout(600_000)`.
   */
  async waitForAiIdle(timeout = 240_000): Promise<void> {
    await expect(this.ai.promptBar).toHaveAttribute('data-active', 'false', { timeout })
    await this.expectAiSessionSucceeded()
  }

  /**
   * Fail when my last AI session ended in an error (turn limit, session
   * cap, provider failure, …). The prompt bar mirrors the session's
   * terminal phase into `data-last-outcome` (`done` | `error`, empty
   * while none has ended) and the server's message into
   * `data-last-outcome-message`. Without this check a flow passed even
   * when the user saw "Could not reach markoto — Hit turn limit".
   */
  async expectAiSessionSucceeded(timeout = 15_000): Promise<void> {
    const bar = this.ai.promptBar
    await expect(bar).toHaveAttribute('data-last-outcome', /^(done|error)$/, { timeout })
    const outcome = await bar.getAttribute('data-last-outcome')
    if (outcome !== 'done') {
      const message = await bar.getAttribute('data-last-outcome-message')
      throw new Error(`AI session ended with an error: ${message ?? '(no message)'}`)
    }
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
   * Turn the cover page off (or on) for the current document so the
   * preview shows page 1 = the content the flow is about, not the
   * markoto title sheet every new doc opens with.
   *
   * Writes the theme the same way the Theme panel's cover switch does:
   * into the shared `ymeta.theme` (via the flow stack's `__DEBUG_ydoc`
   * test handle, NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1), so it applies live
   * for every collaborator and works for anonymous docs too. The old
   * implementation PUT /meta, which only updates the stored seed — an
   * editor that had already loaded kept rendering the cover, which is
   * why so many published frames showed nothing but "Untitled".
   *
   * Starts from the live theme (ymeta) or, before anyone touched it,
   * the stored one (GET /meta) so a preset picked in the new-document
   * dialog survives. When the preview is mounted, waits until it has
   * repaginated with/without the cover.
   */
  async setCoverEnabled(enabled: boolean): Promise<void> {
    const docId = this.currentDocId()
    const { defaultTheme } = await import('../../../shared/utils/defaultTheme')
    const metaRes = await this.page.request.get(`/api/docs/${docId}/meta`)
    const metaBody: unknown = metaRes.ok() ? await metaRes.json() : null
    const stored: unknown = typeof metaBody === 'object' && metaBody !== null ? Reflect.get(metaBody, 'theme') : null
    const applied = await this.page.evaluate(({ enabled, stored, fallback }) => {
      const ydoc: unknown = Reflect.get(globalThis, '__DEBUG_ydoc')
      if (typeof ydoc !== 'object' || ydoc === null) return false
      const getMap: unknown = Reflect.get(ydoc, 'getMap')
      if (typeof getMap !== 'function') return false
      const meta: unknown = getMap.call(ydoc, 'meta')
      if (typeof meta !== 'object' || meta === null) return false
      const get: unknown = Reflect.get(meta, 'get')
      const set: unknown = Reflect.get(meta, 'set')
      if (typeof get !== 'function' || typeof set !== 'function') return false
      const live: unknown = get.call(meta, 'theme')
      let base: object = fallback
      if (typeof stored === 'object' && stored !== null) base = stored
      if (typeof live === 'object' && live !== null) base = live
      const cover: unknown = Reflect.get(base, 'cover')
      const coverBase = typeof cover === 'object' && cover !== null ? cover : {}
      set.call(meta, 'theme', { ...base, cover: { ...coverBase, enabled } })
      return true
    }, { enabled, stored, fallback: defaultTheme })
    if (!applied) {
      throw new Error('[setCoverEnabled] window.__DEBUG_ydoc is missing — run against the flow stack (NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1)')
    }
    if (await this.page.locator('iframe').count() > 0) {
      const cover = this.page.frameLocator('iframe').first().locator('#mount .markoto-cover')
      await expect(cover).toHaveCount(enabled ? 1 : 0, { timeout: 15_000 })
      await this.waitForPreviewPaginated()
    }
  }

  /** Shorthand for `setCoverEnabled(false)`. */
  async disableCoverPage(): Promise<void> {
    await this.setCoverEnabled(false)
  }

  /** The `/d/:id` id of the open document. Throws off the editor. */
  currentDocId(): string {
    const m = /\/d\/([^/?]+)/.exec(new URL(this.page.url()).pathname)
    if (!m) throw new Error(`[currentDocId] not on a /d/{id} route, got ${this.page.url()}`)
    return m[1]
  }

  /**
   * The authoritative document text (Y.Text), via the flow stack's
   * `__DEBUG_ytext` handle. Prefer this over `.cm-content` — CM6
   * virtualises long documents, so the DOM only holds the viewport.
   */
  async docText(): Promise<string> {
    return await this.page.evaluate(() => {
      const ytext: unknown = Reflect.get(globalThis, '__DEBUG_ytext')
      if (typeof ytext !== 'object' || ytext === null) return ''
      const toText: unknown = Reflect.get(ytext, 'toString')
      return typeof toText === 'function' ? String(toText.call(ytext)) : ''
    })
  }

  /**
   * Replace the whole document text (Y.Text) with `markdown`, as one
   * edit by this user — e.g. a short, realistic starting draft instead
   * of the long Demo document, so the flow's outcome fits on the
   * first preview page. Waits until the editor shows the new text.
   */
  /** Does the open document seed a template body on its first sync? */
  private async hasTemplateSeed(): Promise<boolean> {
    const docId = /\/d\/([^/?#]+)/.exec(this.page.url())?.[1]
    if (!docId) throw new Error(`[setDocText] not on a document page: ${this.page.url()}`)
    const res = await this.page.request.get(`/api/docs/${docId}/meta`)
    if (!res.ok()) throw new Error(`[setDocText] meta request failed: ${res.status()}`)
    const meta: unknown = await res.json()
    if (typeof meta !== 'object' || meta === null) return false
    const body: unknown = Reflect.get(meta, 'initialBody')
    return typeof body === 'string' && body.length > 0
  }

  async setDocText(markdown: string): Promise<void> {
    // A new doc seeds its template body (Demo, by default) on the first
    // sync — wait for it, so the seed can't land after (and next to) our
    // text. A Blank document (incl. one made by a bare POST /api/docs)
    // never gets a body: its meta has `initialBody: null`, nothing to wait for.
    if (await this.hasTemplateSeed()) {
      await expect.poll(() => this.docText(), { message: 'document never synced its initial body' }).not.toBe('')
    }
    const applied = await this.page.evaluate((text: string) => {
      const ytext: unknown = Reflect.get(globalThis, '__DEBUG_ytext')
      if (typeof ytext !== 'object' || ytext === null) return false
      const length: unknown = Reflect.get(ytext, 'length')
      const del: unknown = Reflect.get(ytext, 'delete')
      const insert: unknown = Reflect.get(ytext, 'insert')
      if (typeof length !== 'number' || typeof del !== 'function' || typeof insert !== 'function') return false
      if (length > 0) del.call(ytext, 0, length)
      insert.call(ytext, 0, text)
      return true
    }, markdown)
    if (!applied) {
      throw new Error('[setDocText] window.__DEBUG_ytext is missing — run against the flow stack (NUXT_PUBLIC_EXPOSE_TEST_HANDLES=1)')
    }
    await expect.poll(() => this.docText()).toBe(markdown)
    const firstLine = markdown.split('\n').find(l => l.trim().length > 0)
    if (firstLine) await expect(this.page.locator('.cm-line', { hasText: firstLine.replace(/^#+\s*/, '') }).first()).toBeAttached()
  }

  /**
   * Close every open toast (Nuxt UI's close button on each) and wait
   * until none is left — so an outcome frame doesn't show stale toasts
   * from earlier steps stacked over the one that matters.
   */
  async dismissToasts(): Promise<void> {
    const open = this.page.locator('[data-slot="viewport"] li[data-state="open"]')
    for (let i = await open.count(); i > 0; i--) {
      const close = open.first().locator('[data-slot="close"]')
      if (await close.count() === 0) break
      await close.click()
    }
    await expect(this.page.locator('[data-slot="viewport"] li[data-state]')).toHaveCount(0, { timeout: 10_000 })
  }

  /**
   * The non-empty lines of the current document that weren't in
   * `before` — i.e. what an AI run (or a collaborator) added.
   */
  async addedText(before: string): Promise<string> {
    const old = new Set(before.split('\n'))
    return (await this.docText()).split('\n').filter(l => l.trim() && !old.has(l)).join('\n')
  }

  /**
   * Scroll the editor so the first line containing `text` is in view
   * (e.g. the paragraph the AI just inserted), for an outcome shot that
   * shows the result rather than the top of the document.
   */
  async scrollEditorTo(text: string | RegExp): Promise<void> {
    const line = this.page.locator('.cm-line', { hasText: text }).first()
    await expect(line).toBeAttached({ timeout: 15_000 })
    await line.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))
  }

  /**
   * Scroll the live preview so the first element matching `selector`
   * inside the rendered pages is in view. No-op when the preview isn't
   * mounted (mobile edit mode).
   */
  async scrollPreviewTo(selector: string): Promise<void> {
    if (await this.page.locator('iframe').count() === 0) return
    const target = this.page.frameLocator('iframe').first().locator(`#mount ${selector}`).first()
    await expect(target).toBeAttached({ timeout: 15_000 })
    await target.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))
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
   *  or File menu. The title is in view; the template (text + design,
   *  one choice: "Template") and description / language / audience
   *  ("Details") sit in collapsed rows —
   *  open one with `section(id)` (or `openNewDocSection`) before using its
   *  cards or inputs. One submit path: `submitCreate`.
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
      // `newdoc-template-card-saved-<themeId>` for "Blank in <saved design>").
      // Cleaner + faster than text matching.
      templateCard: (id: string) => this.page.locator(`[data-testid="newdoc-template-card-${id}"]`),
      /** The collapsed option row's trigger (`template` / `details`). */
      section: (id: 'template' | 'details') => this.page.locator(`[data-testid="newdoc-section-${id}"]`),
      /** The one-line summary on a collapsed row. */
      summary: (id: 'template' | 'details') => this.page.locator(`[data-testid="newdoc-section-${id}-summary"]`),
      submitCreate: this.page.locator('[data-testid="newdoc-submit-create"]'),
      cancel: this.page.locator('[data-testid="newdoc-cancel"]')
    }
  }

  /** Expand one of the new-doc dialog's option rows (no-op when open). */
  async openNewDocSection(id: 'template' | 'details'): Promise<void> {
    const trigger = this.newDocDialog.section(id)
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  }

  /** The accept-terms step an ANONYMOUS visitor sees before their first
   *  document in this browser (`DocumentAnonGateDialog`). The bot check
   *  behind it is the real ALTCHA proof of work, solved by the browser's
   *  web worker (test difficulty on the flow stack) — nothing is bypassed. */
  get anonGate() {
    return {
      dialog: this.page.locator('[data-testid="anon-gate-dialog"]'),
      accept: this.page.locator('[data-testid="anon-gate-accept"]'),
      continue: this.page.locator('[data-testid="anon-gate-continue"]'),
      botCheck: this.page.locator('[data-testid="anon-gate-botcheck"]')
    }
  }

  /** Tick the terms box and continue (the dialog must be open). */
  async acceptAnonGate(): Promise<void> {
    await expect(this.anonGate.dialog).toBeVisible()
    await this.anonGate.accept.click()
    await expect(this.anonGate.continue).toBeEnabled()
    await this.anonGate.continue.click()
  }

  /**
   * Click a create button and get to the new document: passes the
   * accept-terms step when it appears (anonymous, first document in this
   * browser) and waits for /d/:id either way. Signed-in users never see
   * the step.
   */
  async clickCreateAndPassGate(button: Locator): Promise<void> {
    await button.click()
    const gate = this.anonGate.dialog
    await Promise.race([
      this.page.waitForURL(/\/d\/[^/]+/, { timeout: 30_000 }),
      gate.waitFor({ state: 'visible', timeout: 30_000 })
    ])
    if (await gate.isVisible()) await this.acceptAnonGate()
    // The bot check may still be solving when "continue" is clicked.
    await this.page.waitForURL(/\/d\/[^/]+/, { timeout: 30_000 })
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
  /** Mobile only: the floating edit ⇄ preview switch's Preview button. */
  get mobilePreviewButton(): Locator {
    return this.page.locator('[data-testid="mobile-viewmode-bar"] button').nth(1)
  }

  /**
   * Mobile only: switch to the rendered preview (mobile is edit-only by
   * default, so result frames otherwise show raw markdown) and wait for
   * its pages.
   */
  async showMobilePreview(): Promise<void> {
    await this.mobilePreviewButton.click()
    await expect(this.mobilePreviewButton).toHaveAttribute('aria-pressed', 'true')
    await this.waitForPreviewPaginated()
  }

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
   *
   * **Scope to `#mount` deliberately.** The iframe has two paged-mount
   * divs in DOM order: `#mount` (visible target) and `#pending`
   * (offscreen scratch — `position:fixed; left:-10000px; visibility:hidden`).
   * paged.js renders into `#pending` first, then `replaceChildren`-swaps
   * the pages into `#mount`. On the *first* render after the iframe
   * is created (e.g. after a route navigation that re-mounts
   * PreviewPane — happens on duplicate-doc), `#mount` is empty while
   * paged.js is mid-fill of `#pending`. An unscoped `.pagedjs_page`
   * `.first()` would then match a `#pending` element and report it
   * hidden for the entire wait window. Scoping to `#mount` ensures
   * we only match the swapped-in (visible) pages.
   */
  /**
   * The preview iframe's root element, for `evaluate` INSIDE the frame.
   * The preview runs sandboxed in an opaque origin, so the page can't
   * reach `iframe.contentDocument`; Playwright evaluates in the frame's
   * own context instead.
   */
  previewRoot(): Locator {
    return this.page.frameLocator('iframe').first().locator('html')
  }

  async waitForPreviewPaginated(timeout = 15_000): Promise<void> {
    await this.page
      .frameLocator('iframe')
      .locator('#mount .pagedjs_page')
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
   * `options.email` stores a verified account email on the row — what
   * workspace invitations are matched against (the invited teammate in
   * `invite-a-teammate`) and what the profile page shows. Omitted =
   * NULL, like an OAuth account without a verified address.
   * `options.locale` sets the account language (profile page, emails);
   * omitted = NULL (shown as "—").
   *
   * Returns the user id so callers can use it (e.g. for billing
   * resolution checks).
   */
  async loginAsTestUser(
    name: string,
    options: { email?: string, locale?: string } = {}
  ): Promise<{ userId: number, name: string }> {
    // Postgres lives at the ephemeral test stack's port (5433). The
    // pool stays open per test for ~25ms total work; closing it after
    // every login would force a fresh TCP handshake on every flow.
    const pool = new Pool({
      connectionString: 'postgres://ypad:testpassword@localhost:5433/ypad_test',
      max: 1
    })
    try {
      const githubId = `flow-test-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`
      // Seed the onboarding columns directly so the user row matches a
      // post-Welcome-modal state. Mirrors `tests/integration/setup/
      // fixtures.ts:createUser()` non-fresh path. Without this, every
      // `POST /api/workspaces` returns 409 `workspace/dpa-required`
      // (the DPA gate added in Workstream B), and every flow that
      // touches workspaces fails at setup. Versions read from
      // `shared/legal/versions.ts` so a future PRIVACY_VERSION bump
      // can't desync the OnboardingGate's "needs re-acceptance"
      // check from the test seed (which previously hard-coded 2/1/1
      // and broke every flow on the next bump).
      const result = await pool.query<{ id: number }>(
        `INSERT INTO users (
           github_id, name, email, locale, plan,
           age_confirmed_at,
           privacy_version_accepted, privacy_version_accepted_locale,
           tos_version_accepted, tos_version_accepted_locale,
           dpa_version_accepted, dpa_version_accepted_locale
         )
         VALUES ($1, $2, $6, $7, 'free', NOW(), $3, 'en', $4, 'en', $5, 'en')
         ON CONFLICT (github_id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           locale = EXCLUDED.locale,
           age_confirmed_at = EXCLUDED.age_confirmed_at,
           privacy_version_accepted = EXCLUDED.privacy_version_accepted,
           privacy_version_accepted_locale = EXCLUDED.privacy_version_accepted_locale,
           tos_version_accepted = EXCLUDED.tos_version_accepted,
           tos_version_accepted_locale = EXCLUDED.tos_version_accepted_locale,
           dpa_version_accepted = EXCLUDED.dpa_version_accepted,
           dpa_version_accepted_locale = EXCLUDED.dpa_version_accepted_locale
         RETURNING id`,
        [githubId, name, PRIVACY_VERSION, TOS_VERSION, DPA_VERSION, options.email ?? null, options.locale ?? null]
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
   * Go to the homepage, open the new-document dialog, create a doc with
   * the dialog's defaults (the Demo template — `submitBlank` would give
   * an empty document), passing the accept-terms step when anonymous,
   * and wait for /d/{id}. Does NOT wait for the WS handshake — call
   * waitForReady() after.
   */
  async createNewDoc(): Promise<void> {
    await this.openNewDocDialog()
    await this.clickCreateAndPassGate(this.newDocDialog.submitCreate)
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
    await this.clickCreateAndPassGate(this.newDocDialog.submitCreate)
    await this.waitForReady()
  }
}
