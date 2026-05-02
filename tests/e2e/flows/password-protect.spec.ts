import { test, expect } from '../fixtures/flow'

// Tier 1: "Lock a document with a password".
//
// User-job: a writer wants to share a doc by URL but only with
// people who know a passphrase. Job done when the access mode is
// switched to password-protected, the password is set, and a
// fresh visitor (no JWT cookie) is gated behind the password
// modal until they enter the correct passphrase.
//
// Single-context simulation: instead of opening a separate
// browser context (which would require fixture changes to capture
// screenshots from both), we set the password as the OWNER, then
// clear the doc-scoped JWT cookie + reload — same effective state
// as a fresh visitor (no `doc-{docId}-jwt` cookie). The narrative
// frames this as "what your visitor sees" so the simulation is
// honest with the reader.
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
  await editor.silentSetup()

  // ─── Open the share dialog ───────────────────────────────────────
  await flow.heading('Lock the doc with a password', 3)
  await flow.narrate(
    'Anonymous documents start in open-edit mode — anyone with the '
    + 'link can read AND write. To gate access behind a passphrase, '
    + 'open the share dialog from the lock icon in the topbar.'
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
    + 'appears below — choose something at least 4 characters, '
    + "memorable enough to share verbally with whoever needs in. "
    + "markoto stores only a scrypt hash; the plaintext is never "
    + 'persisted server-side.'
  )

  // The four access mode options render as buttons inside the share
  // modal. Match by the i18n label text (en) — the button isn't
  // a role=radio because the markup uses plain <button> elements.
  const passwordOption = page.locator('[data-testid="share-modal"]').getByRole('button', { name: /password protected/i })
  await flow.click(
    'Pick "Password protected"',
    passwordOption,
    {
      annotations: [
        { label: 'password mode', selector: '[data-testid="share-modal"] button:has-text("Password protected")', kind: 'arrow' }
      ],
      result: 'The password input appears — type a passphrase to lock the doc.',
      after: () => page.locator('input[type="password"]').first().waitFor({ state: 'visible' })
    }
  )

  // Type the password + click Save. Reuse the same value at unlock.
  const sharedPassword = 'open-sesame'
  const passwordInput = page.locator('input[type="password"]').first()
  await flow.type(
    'Type a passphrase',
    passwordInput,
    sharedPassword,
    {
      result: 'The passphrase is staged — Save commits the hash to the server.'
    }
  )

  // The Save button is in the password input row. Filter to the one
  // adjacent to the password input (the share modal also has other
  // buttons that COULD match /save/i in some i18n locales).
  const saveBtn = page.locator('[data-testid="share-modal"]').getByRole('button', { name: /^save$/i })
  await flow.click(
    'Click Save to commit the password',
    saveBtn,
    {
      result: 'The doc is now gated — the access-mode banner shows "password protected".',
      after: async () => {
        // Server hashes + returns; the dialog re-reads the access
        // mode from the parent. Brief settle so the next screenshot
        // catches the updated badge.
        await page.waitForTimeout(800)
      }
    }
  )

  // ASSERTION: server returned the access mode change. The share
  // modal auto-closes once the password is saved, so we check the
  // topbar's access-lock button — its aria-label reflects the
  // current mode (`Access Mode: Password protected`).
  await expect(editor.page.accessLockButton).toHaveAttribute('aria-label', /password protected/i)

  // ─── What your visitor sees ──────────────────────────────────────
  await flow.heading('What your visitor sees', 3)
  await flow.narrate(
    'A first-time visitor — no JWT cookie for this doc — hits the '
    + 'password modal before the editor mounts. The modal blocks '
    + 'every layer: the JWT issued by the token endpoint is '
    + '`null`, the Y.js handshake is rejected, and the editor '
    + 'markup is hidden until verification succeeds. To simulate '
    + 'a visitor in this single browser, we drop the doc-scoped '
    + 'cookie and reload.'
  )

  // Capture the doc URL before clearing cookies (the URL itself
  // doesn't change, but we want to be explicit about what we
  // navigate back to).
  const docUrl = page.url()

  // Clear ALL cookies on this page's context — that includes the
  // doc-scoped JWT. The page reloads as if a brand-new visitor
  // landed on the share link.
  await page.context().clearCookies()
  await page.goto(docUrl)

  // Heads-up: from this point the page is "the visitor", not "the
  // owner". The PasswordModal renders before the editor.
  const visitorPasswordInput = page.locator('input[type="password"]').first()
  await visitorPasswordInput.waitFor({ state: 'visible', timeout: 10_000 })

  await flow.shot(
    'A blocking dialog asks for the password — the editor is hidden until you enter it.',
    {
      annotations: [
        { label: 'password input', selector: 'input[type="password"]', kind: 'arrow' }
      ]
    }
  )

  // ─── Unlock the doc ──────────────────────────────────────────────
  await flow.heading('Unlock with the passphrase', 3)
  await flow.narrate(
    'Type the passphrase and the gate lifts. markoto sets a '
    + 'short-lived doc-scoped cookie so future page loads in this '
    + 'browser skip the modal until the cookie expires. The '
    + 'passphrase travels over HTTPS only; the server compares '
    + "scrypt hashes, not the plaintext."
  )

  await flow.type(
    'Type the passphrase',
    visitorPasswordInput,
    sharedPassword,
    {
      result: 'The passphrase is ready — Unlock submits it for verification.'
    }
  )

  // Click Unlock. The button is "type=submit" inside the form;
  // pressing Enter would also work, but a deliberate click reads
  // more clearly in the slideshow.
  const unlockBtn = page.getByRole('button', { name: /unlock/i })
  await flow.click(
    'Click "Unlock" to enter the doc',
    unlockBtn,
    {
      // Hero outcome: the doc is unlocked + the editor materialises.
      // This IS the "your gated link works" payoff.
      hero: true,
      result: 'The password modal closes — the editor mounts and the doc loads.',
      after: async () => {
        // The modal closes once the cookie is set + the password
        // verifies. Wait for the editor's title button (proxy for
        // "the doc loaded") rather than racing the modal-close
        // animation.
        await editor.page.titleButton.waitFor({ state: 'visible', timeout: 15_000 })
      }
    }
  )

  // ASSERTION: the password modal is gone AND the editor is shown.
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(editor.page.titleButton).toBeVisible()

  // Forward route: the natural next step after locking down a
  // doc is sending a polished version to the password-holder.
  flow.next({
    slug: 'polished-pdf',
    why: 'Now polish it and send a PDF — the password gate stays in place'
  })
})
