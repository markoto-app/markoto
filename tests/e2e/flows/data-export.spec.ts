import { test, expect } from '../fixtures/flow'

// Tier 2 (Privacy): "Get a copy of everything we hold about you".
//
// User-job: under GDPR Article 20 (data portability) + Article 15
// (right of access), the user has the right to a machine-readable
// copy of every personal data point markoto attributes to them.
// markoto produces this on demand: click a button, get an email
// when the ZIP is ready, download from /settings/profile. The
// archive is plain JSON / NDJSON / Markdown so the user can pipe
// it into other tooling without parsing a vendor format.
//
// What this flow IS: the canonical "right of access" UX. Compliance
// reviewers see request → background build → download in one
// continuous demo. Useful pair to the deletion flow, the right
// answer to "I want to leave but keep my work" is "export first,
// then delete".
//
// What this flow IS NOT: a tour of the ZIP layout. The README at
// the top of the archive itself describes every entry in plain
// English; surfacing it here would just paraphrase that text.
//
// Single-actor flow. The profile page is responsive, same flow
// runs in both desktop and mobile project variants. Mobile layout
// stacks the history-row metadata vertically below each row's
// status pill rather than packing horizontally.

test('Data export', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  // A complete profile: the export flow opens on the profile page, so
  // its Email and Language rows must show real values, not ", ".
  await editor.page.loginAsTestUser('Maya Chen', { email: 'maya.chen@studio.example', locale: 'en' })

  // Seed a workspace + a doc so the export has real personal data
  // to surface. The story is the export pipeline, not the seeding,
  // so we go through the API rather than a fixture composition,
  // mirrors how a real user's account would have grown.
  const wsRes = await page.request.post('/api/workspaces', {
    data: { name: 'Sample workspace' }
  })
  if (!wsRes.ok()) throw new Error(`workspace create failed: ${wsRes.status()}`)
  const ws = await wsRes.json() as { workspaceId: string }

  const docRes = await page.request.post('/api/docs', {
    data: {
      workspaceId: ws.workspaceId,
      title: 'Q3 launch notes',
      description: 'Demo doc for the export flow',
      accessMode: 'private'
    }
  })
  if (!docRes.ok()) throw new Error(`doc create failed: ${docRes.status()}`)

  await page.goto('/settings/profile')
  await page.locator('[data-testid="export-request-button"]').waitFor({ state: 'visible', timeout: 10_000 })

  // Chapter 1: Why export
  await flow.heading('Get a copy of everything we hold about you', 3)
  await flow.narrate(
    'You have the right to a machine-readable copy of every piece of '
    + 'personal data markoto holds about you (GDPR Articles 15 and 20). '
    + 'One click starts building the archive, you get an email when it '
    + 'is ready, and a download link stays on this page for seven days. '
    + 'The ZIP holds plain JSON and Markdown files, no special software '
    + 'needed to open it.'
  )

  // Chapter 2: Request the export
  await flow.heading('Request the export', 3)
  await flow.narrate(
    'The archive covers your account profile, every document you own '
    + 'as Markdown, comments you wrote, your AI prompts and what the AI '
    + 'did for you, your billing records, the security log entries about '
    + 'your account and every consent decision you made. A README in '
    + 'the archive explains each file in plain English.'
  )

  await flow.click(
    'Click "Request export"',
    page.locator('[data-testid="export-request-button"]'),
    {
      result: 'A new row appears under Recent exports with the status "queued", markoto builds it in the background.',
      after: () => page.locator('[data-testid="export-history-row"]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  await expect(page.locator('[data-testid="export-history-row"]').first()).toContainText(/queued|running/i)

  // Chapter 3: Wait for the worker to build
  await flow.heading('Your archive is ready', 3)
  await flow.narrate(
    'Building the archive usually takes under a minute. You can close '
    + 'the page meanwhile: markoto emails you when it is done, and the '
    + 'row here switches to ready with a Download button.'
  )

  // The ephemeral test stack runs the same worker plugin (1-minute
  // interval), but waiting on that here would only add a minute of
  // nothing. Tick the worker explicitly via the TEST_MODE-gated
  // endpoint: the same code the plugin runs.
  const tickRes = await page.request.post('/api/_test/run-export-worker')
  if (!tickRes.ok()) throw new Error(`worker tick failed: ${tickRes.status()}`)

  // Re-route to the same page so the history list re-fetches.
  // Replacing the URL keeps the cursor coordinates valid for the
  // next screenshot (vs reload which scrubs them).
  await page.goto('/settings/profile')
  await page.locator('[data-testid="export-history-row"]').first().waitFor({ state: 'visible' })
  await expect(page.locator('[data-testid="export-history-row"]').first()).toContainText(/ready/i, { timeout: 5_000 })
  await page.locator('[data-testid="export-download-button"]').first().waitFor({ state: 'visible', timeout: 5_000 })
  // The profile page opens at the top (account details); bring the
  // ready export into view for the outcome frame.
  await page.locator('[data-testid="export-history-row"]').first().evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }))

  await flow.shot(
    'The row says ready, with the archive\'s size and the date the '
    + 'link expires. Download is one click away.',
    {
      hero: true,
      highlights: [
        { label: 'Download', selector: '[data-testid="export-download-button"]' }
      ]
    }
  )

  // Chapter 4: Verify the download endpoint
  await flow.heading('Download the archive', 3)
  await flow.narrate(
    'Click Download and the ZIP lands on disk. Each click hands your '
    + 'browser a short-lived link to the file, so a link that leaks '
    + 'stops working after a few minutes. If a slow connection drops '
    + 'mid-download, click Download again, the archive is not rebuilt.'
  )

  // Resolve the download URL cleanly, Playwright's getAttribute
  // returns a Promise<string|null>, so await it before passing to
  // request.get. Then issue a non-following GET to assert the
  // 302 → presigned-URL redirect contract WITHOUT actually streaming
  // the bytes (the seaweedfs presign in the test stack works for
  // PUTs/GETs from the app container; from the Playwright runner
  // it's network-namespaced differently).
  const href = await page.locator('[data-testid="export-download-button"]').first().getAttribute('href') ?? ''
  expect(href).not.toBe('')
  const downloadRes = await page.request.get(href, { maxRedirects: 0 })
  expect(downloadRes.status()).toBeGreaterThanOrEqual(300)
  expect(downloadRes.status()).toBeLessThan(400)
  const location = downloadRes.headers()['location'] ?? ''
  expect(location).toContain('exports/')

  await flow.shot(
    'Download hands your browser a fresh, short-lived link to the '
    + 'archive: valid long enough for a slow connection, not long '
    + 'enough to linger in someone else\'s chat history.'
  )

  flow.next({
    slug: 'delete-account-with-consequences',
    why: 'Ready to leave the platform? Here\'s exactly what happens when you delete'
  })
})
