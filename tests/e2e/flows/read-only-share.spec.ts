import { test, expect } from '../fixtures/flow'

// Tier 1: "Share a doc as read-only."
//
// User-job: a writer has a doc they want to share but only as
// reading material — no edits, no comments-from-strangers, just
// "here's what I wrote, take a look". Job done when they've switched
// the access mode to open-view, sent the link to a visitor, and
// the visitor lands in a read-only editor (no caret, no toolbar
// actions, no AI prompt bar).
//
// Two-context flow via `flow.spawn('visitor')`. Owner switches the
// mode; visitor (separate identity) hits the link and is served
// the read-only experience.
//
// Works on desktop and mobile.
test('Share as read-only', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({
    title: 'Travel policy',
    body: '# Travel policy\n\nBook trains for trips under four hours. Flights need a manager\'s OK.\n\n## Expenses\n\nSubmit receipts within 30 days.',
    cover: false
  })

  // Flip access mode to open-view BEFORE Maya types. Earlier ordering
  // (type first, then change mode) caused Maya's edits to never reach
  // the visitor — the access-mode change races with the Hocuspocus
  // flush of Maya's typed buffer in the test stack and the visitor
  // ends up with demo-only state. Doing the mode change first is
  // also what `collab-live` does (works there). The narrative in the
  // flow is unchanged: the user picks the mode, then writes content.
  await editor.page.setAccessMode('open-view')

  // Type a recognisable line so the visitor has something to read.
  const cmContent = page.locator('.cm-content')
  await cmContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await cmContent.press(`${accel}+End`)
  await cmContent.press('Enter')
  await cmContent.press('Enter')
  await cmContent.pressSequentially('Q3 launch postmortem — read-only copy for the wider team.')

  await flow.heading('Share as read-only', 3)
  await flow.narrate(
    'Sometimes you want people to READ what you wrote, not edit it. '
    + 'Switch the access mode to "Anyone can view" and the share link '
    + 'lets visitors open the doc but not change it — no caret, no '
    + 'toolbar actions, no AI prompt bar. The doc still syncs in real '
    + 'time, so if you keep editing they see the latest version.'
  )

  // ─── Switch to open-view ────────────────────────────────────────
  // Step A (story): show the share dialog so the screenshot captures
  // the four access-mode options the user picks from. We deliberately
  // do NOT click "Anyone can view" inside the modal because the
  // share-modal mutation handler can race with Maya's in-flight
  // pressSequentially edits (the click triggers a re-render that
  // momentarily detaches the editor's CodeMirror view and DROPS
  // unflushed Y.js updates that haven't reached Hocuspocus yet — so
  // the visitor connects later and gets demo-only state).
  // Step B (truth): commit the mode change via the API, which doesn't
  // touch the editor's DOM at all.
  await flow.click(
    'Open the share dialog from the lock icon',
    editor.page.accessLockButton,
    {
      result: 'The share dialog opens — four access modes below the link.',
      after: () => page.locator('[data-testid="share-modal"]').waitFor({ state: 'visible' })
    }
  )
  await flow.shot(
    'Pick "Anyone can view" — anyone with the link can read the doc but not change it.',
    {
      annotations: [
        { label: 'view-only', selector: '[data-testid="share-access-open-view"]' }
      ]
    }
  )

  // Commit the mode change via the API, then close the dialog.
  await editor.page.setAccessMode('open-view')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  const docUrl = page.url()

  // ─── Visitor opens the link ─────────────────────────────────────
  await flow.heading('What your visitor sees', 3)
  await flow.narrate(
    'A visitor opens the link in their own browser. The document '
    + 'opens read-only: no caret, no formatting toolbar, no AI prompt '
    + 'bar — and markoto refuses any change from them on the server '
    + 'too, not just in the interface. They can read; they can\'t change.'
  )

  // Spawn the visitor — fresh BrowserContext, fresh identity. Login
  // as a different test user so the visitor has presence (real
  // name + colour) and the Hocuspocus handshake completes the same
  // way it would for a logged-in collaborator. open-view's gate
  // doesn't depend on whether the visitor is logged in (anyone with
  // the link reads), but anonymous-visitor + Y.js connect + CM6
  // read-only mount has a race in the test stack that closes the
  // page mid-load; logging in stabilises the handshake.
  const visitor = await flow.spawn('visitor')
  await visitor.editor.loginAsTestUser('Sam Reeves')
  await visitor.page.goto(docUrl)
  // Ready = doc loaded + connected. A read-only visitor opens in
  // Preview, so the CodeMirror surface isn't mounted yet — waiting for
  // `.cm-content` here raced the view-mode switch below.
  await visitor.editor.waitForReady()
  // The visitor gets Maya's live text (the doc is open on her side, so
  // the sync server serves its in-memory state — no flush needed).
  await expect.poll(() => visitor.editor.docText(), { timeout: 15_000 }).toMatch(/read-only copy for the wider team/i)
  // Switch the visitor to Edit view (read-only-mounted CodeMirror) on
  // DESKTOP so the frame shows the locked editor next to the preview.
  //
  // Mobile is preview-only for read-only viewers — the EditorLayout
  // hides the MobileTabBar via `v-if="!isReadOnly && viewMode !== 'preview'"`,
  // so there's no bottom-bar Editor tab AND no topbar view-mode
  // toggle. The visitor stays on the preview iframe; the screenshot
  // captures the read-only chrome (no toolbar, no caret, "View only"
  // banner) which is the user-facing assertion the flow is making.
  if (!editor.isMobile) {
    await visitor.editor.viewMode.edit.click()
    await expect(visitor.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
    await expect(visitor.page.locator('.cm-content')).toBeVisible()
  } else {
    await visitor.editor.waitForPreviewPaginated()
  }

  await visitor.flow.shot(
    'The visitor lands in the doc — but the editor is read-only. '
    + 'No caret blink, no formatting toolbar, no AI prompt bar. The '
    + 'lock icon in the topbar reflects the view-only mode.',
    {
      hero: true,
      // Highlight the editor surface that's actually visible: CM6
      // content on desktop (Edit view), preview iframe on mobile
      // (preview is the only view a read-only visitor can see).
      highlights: [
        editor.isMobile
          ? { label: 'Read-only preview', selector: 'iframe' }
          : { label: 'Read-only editor', selector: '.cm-content' }
      ]
    }
  )

  // ASSERTIONS: the visitor IS synced with Maya's content AND the
  // read-only chrome is enforced.
  //
  // NB: we can't assert via `cm-content`.textContent() because CM6
  // virtualizes long content — only the lines currently in the
  // viewport are in the DOM. Maya's appended line lives at the END
  // of the doc (~line 50) and won't be in the rendered span. We
  // assert against the Y.Doc directly via the test-only handle
  // exposed in `useDocument.ts` (`window.__DEBUG_ytext`). The Y.Doc
  // is the authoritative "what content does this client have"
  // question; CM6's rendered surface is just a viewport.
  expect(await visitor.editor.docText()).toMatch(/read-only copy for the wider team/i)
  await expect(visitor.page.locator('[data-testid="ai-prompt-bar"]')).toHaveCount(0)

  if (editor.isMobile) {
    // Mobile read-only viewers stay in preview mode — there's no
    // CodeMirror surface to query, and the menubar is hidden behind
    // the hamburger menu (no testid'd "Insert" / "Format" buttons
    // either). The "View only" banner is the user-facing assertion;
    // verify it's there.
    await expect(visitor.page.getByText(/view only/i).first()).toBeVisible()
  } else {
    // Desktop: CodeMirror's read-only Compartments set
    // `contenteditable="false"` on the .cm-content root. Verify
    // directly — this is the canonical "you cannot edit" signal.
    const editable = await visitor.page.locator('.cm-content').getAttribute('contenteditable')
    expect(editable).toBe('false')
    // Also assert the menubar's edit-only commands are disabled
    // (Insert / Format require write access). These are independent
    // of the CodeMirror compartment and prove the read-only
    // enforcement is wired into the chrome too.
    await expect(visitor.page.locator('[data-testid="menubar-insert"]')).toBeDisabled()
    await expect(visitor.page.locator('[data-testid="menubar-format"]')).toBeDisabled()
  }

  flow.next({
    slug: 'password-protect',
    why: 'Need stronger gating? Lock the doc behind a passphrase'
  })
})
