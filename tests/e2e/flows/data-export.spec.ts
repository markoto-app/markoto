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
// continuous demo. Useful pair to the deletion flow — the right
// answer to "I want to leave but keep my work" is "export first,
// then delete".
//
// What this flow IS NOT: a tour of the ZIP layout. The README at
// the top of the archive itself describes every entry in plain
// English; surfacing it here would just paraphrase that text.
//
// Single-actor flow. The profile page is responsive — same flow
// runs in both desktop and mobile project variants. Mobile layout
// stacks the history-row metadata vertically below each row's
// status pill rather than packing horizontally.

test('Data export', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')

  // Seed a workspace + a doc so the export has real personal data
  // to surface. The story is the export pipeline, not the seeding,
  // so we go through the API rather than a fixture composition —
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

  // ─── Chapter 1: Why export ─────────────────────────────────────
  await flow.heading('Get a copy of everything we hold about you', 3)
  await flow.narrate(
    'GDPR Article 20 gives you the right to a machine-readable copy '
    + 'of every piece of personal data markoto holds about you. The '
    + 'export feature is how you exercise that right: one click '
    + 'enqueues a background build, you get an email when the archive '
    + 'is ready, and a download link sits here for seven days. The '
    + 'ZIP is plain JSON / NDJSON / Markdown — no vendor format, no '
    + 'parser required to pipe it into other tooling.'
  )

  // ─── Chapter 2: Request the export ─────────────────────────────
  await flow.heading('Request the export', 3)
  await flow.narrate(
    'The request goes into a queue: a worker picks it up, streams '
    + 'the archive to object storage, and flips the row to ready. '
    + 'The build covers your account profile, every document you own '
    + 'as Markdown, comments you authored, AI prompt and tool-call '
    + 'history, billing invoices, audit log entries about your '
    + 'account, every consent decision you made. A README at the '
    + 'top of the archive describes the layout in plain English.'
  )

  await flow.click(
    'Click "Request export"',
    page.locator('[data-testid="export-request-button"]'),
    {
      result: 'A new row appears in the history with status "queued" — the worker takes it from there.',
      after: () => page.locator('[data-testid="export-history-row"]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  await expect(page.locator('[data-testid="export-history-row"]').first()).toContainText(/queued|running/i)

  // ─── Chapter 3: Wait for the worker to build ───────────────────
  await flow.heading('Wait for the worker', 3)
  await flow.narrate(
    'In production, a background plugin runs every minute and picks '
    + 'up queued jobs. For this demo we tick the worker manually so '
    + 'the screenshot doesn\'t sit on a 60-second loading spinner — '
    + 'the production path runs the same code. The worker builds the '
    + 'ZIP in-memory via fflate, writes it to object storage with a '
    + '7-day expiry, and flips the row to ready.'
  )

  // The ephemeral test stack runs the same plugin (1-minute interval),
  // but waiting on that here would slow the flow with a meaningless
  // loading state. Tick the worker explicitly via the TEST_MODE-gated
  // endpoint so the screenshot lands on the ready state directly.
  const tickRes = await page.request.post('/api/_test/run-export-worker')
  if (!tickRes.ok()) throw new Error(`worker tick failed: ${tickRes.status()}`)

  // Re-route to the same page so the history list re-fetches.
  // Replacing the URL keeps the cursor coordinates valid for the
  // next screenshot (vs reload which scrubs them).
  await page.goto('/settings/profile')
  await page.locator('[data-testid="export-history-row"]').first().waitFor({ state: 'visible' })
  await expect(page.locator('[data-testid="export-history-row"]').first()).toContainText(/ready/i, { timeout: 5_000 })
  await page.locator('[data-testid="export-download-button"]').first().waitFor({ state: 'visible', timeout: 5_000 })

  await flow.shot(
    'The row flipped to ready. The size pill and expiry are right '
    + 'there in mono — your archive is on object storage, the '
    + 'Download button issues a 5-minute presigned URL when you click it.',
    {
      hero: true,
      highlights: [
        { label: 'Download', selector: '[data-testid="export-download-button"]' }
      ]
    }
  )

  // ─── Chapter 4: Verify the download endpoint ────────────────────
  await flow.heading('Download the archive', 3)
  await flow.narrate(
    'Click Download and markoto issues a 302 to a 5-minute presigned '
    + 'URL pointing at the ZIP in object storage. The browser follows '
    + 'the redirect and the file lands on disk. The presigned URL is '
    + 'tight on purpose — leaked links have limited reuse. If a slow '
    + 'connection drops mid-download you can request a fresh link by '
    + 'clicking Download again; you don\'t have to rebuild the archive.'
  )

  // Resolve the download URL cleanly — Playwright's getAttribute
  // returns a Promise<string|null>, so await it before passing to
  // request.get. Then issue a non-following GET to assert the
  // 302 → presigned-URL redirect contract WITHOUT actually streaming
  // the bytes (the seaweedfs presign in the test stack works for
  // PUTs/GETs from the app container; from the Playwright runner
  // it's network-namespaced differently).
  const href = await page.locator('[data-testid="export-download-button"]').first().getAttribute('href')
  expect(href).toBeTruthy()
  const downloadRes = await page.request.get(href!, { maxRedirects: 0 })
  expect(downloadRes.status()).toBeGreaterThanOrEqual(300)
  expect(downloadRes.status()).toBeLessThan(400)
  const location = downloadRes.headers()['location'] ?? ''
  expect(location).toContain('exports/')

  await flow.shot(
    'The Download button issues a 302 → presigned URL on the exports/ '
    + 'prefix. Five minutes of validity per click — long enough to '
    + 'survive a slow download, short enough that a leaked link can\'t '
    + 'sit forever in someone\'s scrollback.'
  )

  flow.next({
    slug: 'delete-account-with-consequences',
    why: 'Ready to leave the platform? Here\'s exactly what happens when you delete'
  })
})
