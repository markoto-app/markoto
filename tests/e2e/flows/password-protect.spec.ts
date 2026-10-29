import { test, expect } from '../fixtures/flow'

// Tier 1: "Lock a document with a password".
//
// User-job: a writer wants to share a doc by URL but only with
// people who know a passphrase. Job done when the access mode is
// switched to password-protected, the password is set, and a
// fresh visitor (separate browser identity, no JWT cookie) is
// gated behind the password modal until they enter the correct
// passphrase.
//
// Two-context flow: the OWNER sets the passphrase via the share
// dialog; a VISITOR — a genuinely separate `BrowserContext` spawned
// via `flow.spawn('visitor')` — opens the share link with no
// cookies and hits the PasswordModal. Both actors' frames land in
// the same manifest in call order, so the slideshow reads as one
// linear story.
//
// Desktop AND mobile: the access lock icon is in the topbar on
// both, the share modal is responsive, the password modal is a
// blocking dialog at any width. No skip needed.
test('Password protect', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // Access-mode buttons are owner-only (`v-if="isOwner"` in
  // ShareModal.vue). Anonymous users on anonymous docs are NOT
  // owners (isOwner is `data.ownerId === userId`; both null on
  // anon flows). Log in via the TEST_MODE shim BEFORE silentSetup
  // so the doc is created with this user as owner — they then
  // see the access-mode controls in the share dialog.
  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup({
    title: 'Board meeting notes',
    body: '# Board meeting notes\n\n## Decisions\n\n- Hire two engineers in Q1\n- Move the launch to March\n\n## Next meeting\n\nFirst Monday of the month, 9:00.\n',
    cover: false
  })

  // Title + intro before the captures begin.
  await flow.heading('Lock a document with a password', 3)
  await flow.narrate(
    'Documents share by URL. To gate one, its owner switches the access '
    + 'mode to password-protected and chooses a passphrase. Visitors hit '
    + 'a blocking dialog before they see anything; only the right '
    + 'passphrase gets them past it. Only the owner sees the access-mode '
    + 'picker — sign in first, because a document created without an '
    + 'account has no owner and can\'t be locked.'
  )

  // ─── Open the share dialog ───────────────────────────────────────
  await flow.narrate(
    'Open the share dialog from the lock icon in the topbar.'
  )

  await flow.click(
    'Open the share dialog',
    editor.page.accessLockButton,
    {
      annotations: [
        { label: 'lock icon', selector: '[aria-label*="access mode" i]', kind: 'arrow' }
      ],
      result: 'The share dialog opens — four access modes below the link.',
      after: () => page.locator('[data-testid="share-modal"]').waitFor({ state: 'visible' })
    }
  )

  // ─── Switch to password-protected ────────────────────────────────
  await flow.heading('Switch the access mode', 3)
  await flow.narrate(
    'Tap "Password protected" to gate the doc. The password input '
    + 'appears below — choose at least 8 characters, memorable enough '
    + 'to share verbally with whoever needs in. markoto stores only a '
    + 'one-way hash of it, never the passphrase itself.'
  )

  // The four access mode options render as buttons inside the share
  // modal. Match by the i18n label text (en) — the button isn't
  // a role=radio because the markup uses plain <button> elements.
  const passwordOption = page.locator('[data-testid="share-access-password-protected"]')
  await flow.click(
    'Pick "Password protected"',
    passwordOption,
    {
      annotations: [
        { label: 'password mode', selector: '[data-testid="share-access-password-protected"]', kind: 'arrow' }
      ],
      result: 'The password input appears — type a passphrase to lock the doc.',
      after: () => page.locator('[data-testid="share-password-input"]').waitFor({ state: 'visible' })
    }
  )

  // Type the password + click Save. Reuse the same value at unlock.
  const sharedPassword = 'open-sesame'
  const passwordInput = page.locator('[data-testid="share-password-input"]')
  await flow.type(
    'Type a passphrase',
    passwordInput,
    sharedPassword,
    {
      result: 'The passphrase is typed — Save locks the doc with it.'
    }
  )

  // The Save button is in the password input row. Filter to the one
  // adjacent to the password input (the share modal also has other
  // buttons that COULD match /save/i in some i18n locales).
  const saveBtn = page.locator('[data-testid="share-password-save"]')
  await flow.click(
    'Click Save to commit the password',
    saveBtn,
    {
      result: 'The doc is now gated — the access-mode banner shows "password protected".',
      // The topbar lock reflects the saved mode once the server
      // answered.
      after: () => expect(editor.page.accessLockButton).toHaveAttribute('aria-label', /password protected/i, { timeout: 10_000 })
    }
  )

  // ASSERTION: server returned the access mode change. The share
  // modal auto-closes once the password is saved, so we check the
  // topbar's access-lock button — its aria-label reflects the
  // current mode (`Access Mode: Password protected`).
  await expect(editor.page.accessLockButton).toHaveAttribute('aria-label', /password protected/i)

  // Capture the doc URL — the visitor will navigate to this same
  // link from a fresh BrowserContext (no cookies, no session, no
  // doc-scoped JWT).
  const docUrl = page.url()

  // ─── What your visitor sees ──────────────────────────────────────
  await flow.heading('What your visitor sees', 3)
  await flow.narrate(
    'A first-time visitor — say, in their own browser — opens the '
    + 'link and gets the password dialog first. Until the passphrase '
    + 'checks out, markoto sends them nothing of the document: not '
    + 'the text, not even its title.'
  )

  // Spawn the visitor — a genuinely separate BrowserContext (clean
  // cookies + storage, independent identity). All visitor-side
  // captures push into the same manifest with `actor: 'visitor'`
  // stamped per frame; the spawned context is auto-closed at
  // fixture teardown.
  const visitor = await flow.spawn('visitor')
  await visitor.page.goto(docUrl)

  const visitorPasswordInput = visitor.page.locator('[data-testid="password-modal-input"]')
  await visitorPasswordInput.waitFor({ state: 'visible', timeout: 15_000 })

  await visitor.flow.shot(
    'A blocking dialog asks for the password — the editor is hidden until you enter it.',
    {
      annotations: [
        { label: 'password input', selector: 'input[type="password"]', kind: 'arrow' }
      ]
    }
  )

  // ─── Unlock the doc ──────────────────────────────────────────────
  await visitor.flow.heading('Unlock with the passphrase', 3)
  await visitor.flow.narrate(
    'Type the passphrase and the gate lifts. Too many wrong guesses '
    + 'and markoto pauses password checks on the document for a while, '
    + 'so a passphrase can\'t be brute-forced.'
  )

  await visitor.flow.type(
    'Type the passphrase',
    visitorPasswordInput,
    sharedPassword,
    {
      result: 'The passphrase is ready — Unlock submits it for verification.'
    }
  )

  // Click Unlock. The button is type="submit" inside the form;
  // pressing Enter would also work, but a deliberate click reads
  // more clearly in the slideshow.
  const unlockBtn = visitor.page.locator('[data-testid="password-modal-unlock"]')
  await visitor.flow.click(
    'Click "Unlock" to enter the doc',
    unlockBtn,
    {
      // Hero outcome: the doc is unlocked + the editor materialises.
      // This IS the "your gated link works" payoff. Hero is latched
      // ACROSS actors — the visitor's unlocked frame is the first
      // outcome marked hero in this flow, so it wins.
      hero: true,
      result: 'The password dialog closes and the document opens.',
      after: async () => {
        // Wait for the CodeMirror content surface to be ATTACHED on
        // the visitor's page — the title button is mobile-hidden in
        // some narrow layouts (it sits inside a topbar that gets
        // visually clipped), so a `.cm-content` attach check is the
        // most reliable "doc loaded" proxy across desktop AND
        // mobile. We also wait for the password modal to detach.
        await visitor.page.locator('.cm-content').waitFor({ state: 'attached', timeout: 15_000 })
        await expect(visitor.page.locator('[data-testid="password-modal-input"]')).toHaveCount(0, { timeout: 10_000 })
        await expect(visitor.page.locator('.cm-content')).toContainText('Board meeting notes', { timeout: 15_000 })
        // Desktop shows the live preview next to the editor — wait for
        // its pages, or the hero frame shows an empty preview pane.
        if (!editor.isMobile && await visitor.page.locator('iframe').count() > 0) {
          await visitor.editor.waitForPreviewPaginated()
          await expect(visitor.editor.previewRoot().locator('#mount')).toContainText('Decisions')
        }
      }
    }
  )

  // ASSERTION: the password modal is gone AND the editor surface
  // is in the DOM on the VISITOR's page (not the owner's, which
  // still has the editor visible from before the share dialog
  // ever opened). Use `toBeAttached` rather than `toBeVisible` —
  // mobile narrow layouts hide the title button visually but the
  // `.cm-content` element is the unambiguous "editor mounted"
  // signal.
  await expect(visitor.page.locator('[data-testid="password-modal-input"]')).toHaveCount(0)
  await expect(visitor.page.locator('.cm-content')).toBeAttached()

  // Forward route: the natural next step after locking down a
  // doc is sending a polished version to the password-holder.
  flow.next({
    slug: 'polished-pdf',
    why: 'Now polish it and send a PDF — the password gate stays in place'
  })
})
