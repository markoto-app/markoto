import { test, expect } from '../fixtures/flow'

// "Report a document".
//
// User-job: someone opens a markoto link that contains a scam, illegal
// content or spam and wants it taken down — without an account. Job done
// when the report is submitted and the success panel shows a reference.
//
// Two-context flow: an anonymous WRITER creates the document (passing the
// accept-terms step + the real ALTCHA bot check); a VISITOR in a separate
// browser opens it, sees the "Created by a markoto user … · Report" bar,
// follows the link to the report form (pre-filled with the document's
// address), fills the DSA Art.16 fields and sends it. The visitor's bot
// check is the real proof of work too, solved in their browser's worker.
test('Report a document', async ({ page, flow, editor }) => {
  test.setTimeout(150_000)

  // Anonymous writer: silentSetup passes the terms step for us.
  await editor.silentSetup({
    title: 'Claim your prize',
    body: '# You won a phone!\n\nEnter your bank login on the next page to claim your prize. Offer ends today.\n',
    cover: false
  })
  const docUrl = page.url()

  await flow.heading('Report a document', 3)
  await flow.narrate(
    'Anyone can write on markoto without an account, and markoto does not '
    + 'check what people write. If a link you were sent contains a scam, '
    + 'illegal content or spam, you can report it — no account needed.'
  )

  // The visitor opens the link
  const visitor = await flow.spawn('visitor')
  await visitor.page.goto(docUrl)
  await visitor.editor.waitForReady()
  const bar = visitor.page.locator('[data-testid="user-content-bar"]')
  await expect(bar).toBeVisible()

  await visitor.flow.shot(
    'Documents written without an account carry a note at the top: a markoto user wrote this, not markoto.',
    { highlights: [{ label: 'Written by a user', selector: '[data-testid="user-content-bar"]' }] }
  )

  await visitor.flow.click(
    'Click "Report"',
    visitor.page.locator('[data-testid="user-content-report"]'),
    {
      result: 'The report form opens with the document\'s address already filled in.',
      after: async () => {
        await visitor.page.waitForURL(/\/legal\/abuse/)
        await expect(visitor.page.locator('[data-testid="abuse-form-url"]')).toHaveValue(docUrl)
      }
    }
  )

  // Fill in the report
  await visitor.flow.heading('Say what is wrong', 3)
  await visitor.flow.narrate(
    'Explain why the content is illegal or breaks the rules, and leave your '
    + 'name and email so markoto can confirm your report and tell you what '
    + 'it decided. For reports of child sexual abuse material, name and '
    + 'email are optional.'
  )

  await visitor.flow.type(
    'Explain what is wrong with it',
    visitor.page.locator('[data-testid="abuse-form-body"]'),
    'This page pretends to give away a phone and asks for bank login details. It is a phishing scam.',
    { result: 'The explanation is in.' }
  )
  await visitor.flow.type(
    'Your name',
    visitor.page.locator('[data-testid="abuse-form-name"]'),
    'Sam Visitor',
    { result: 'Name added.' }
  )
  await visitor.flow.type(
    'Your email, for the confirmation and the decision',
    visitor.page.locator('[data-testid="abuse-form-email"]'),
    'sam@example.org',
    { result: 'Email added.' }
  )
  await visitor.flow.click(
    'Confirm that the report is accurate and made in good faith',
    visitor.page.locator('[data-testid="abuse-form-good-faith"]'),
    { result: 'Confirmed. A bot check runs in your browser meanwhile — no account, no tracking.' }
  )

  const submit = visitor.page.locator('[data-testid="abuse-form-submit"]')
  await expect(submit).toBeEnabled()
  await visitor.flow.click(
    'Click "Submit report"',
    submit,
    {
      hero: true,
      result: 'The report is in. You get a confirmation by email and, later, the decision.',
      after: async () => {
        await expect(visitor.page.locator('[data-testid="abuse-report-success"]')).toBeVisible({ timeout: 30_000 })
        await expect(visitor.page.locator('[data-testid="abuse-report-success"]')).toContainText(/rep-/)
      }
    }
  )

  flow.next({ slug: 'quick-share', why: 'write your own document and share it by link' })
})
