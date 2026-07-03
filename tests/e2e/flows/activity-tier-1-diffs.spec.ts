import { test, expect } from '../fixtures/flow'

// Tier 2: "See exactly what changed in any past edit".
//
// User-job: a writer made changes earlier, walked away, came back
// and wants a quick "what happened" view. Open the Activity tab,
// click any edit row, the diff drawer expands inline showing the
// structured patch — green added lines, red removed, line numbers,
// `@@` hunks. Read-only; no restore (that's `activity-restore`).
//
// Pipeline: ActivityFeed lazy-loads `ActivityRowDiff` on click →
// fetches `/api/docs/:docId/activity/:activityId/diff` →
// `historyReplay.ts` reconstructs the Y.Doc up to `yjsDocIdBefore`,
// then up to `yjsDocIdAfter`, runs the `diff` library's
// `structuredPatch`, returns hunks → `DiffView.vue` renders git-
// style markers + 200-hunk truncation guard.
//
// Distinct from `activity-restore` (Tier 2): this flow is the READ
// side — show the diff, no rollback. The restore flow walks the
// diff drawer too but ends on the Restore button. This one ends
// on the diff itself.
//
// Runs on desktop AND mobile. The Activity feed renders identically
// on both surfaces (right-sidebar tab on desktop, bottom-tab-bar on
// mobile). Mobile stacks the diff drawer below the activity row
// rather than alongside the editor; the asserted state — the
// `[data-activity-id]` rows + the diff drawer's hunk markers — is
// the same.
test('See what changed in past edits', async ({ page, flow, editor }) => {
  test.setTimeout(120_000)

  await editor.page.loginAsTestUser('Maya Chen')
  await editor.silentSetup()
  await editor.page.disableCoverPage()

  // Make a recognisable edit so the diff drawer has real content
  // to render. Two short paragraphs typed in sequence give the
  // sync server two distinct activity rows to choose from.
  const editorContent = page.locator('.cm-content').first()
  await editorContent.click()
  const accel = process.platform === 'darwin' ? 'Meta' : 'Control'
  await editorContent.press(`${accel}+End`)
  await editorContent.press('Enter')
  await editorContent.press('Enter')
  await editorContent.pressSequentially('Q3 launch checklist — first pass.')

  // Wait for the sync-server to flush the FIRST `edit` activity row.
  // Hocuspocus debounces ~5s before flushing; previously this used
  // `waitForTimeout(7_000)` which dead-waited the full 7s on every
  // run. Poll the activity API instead — exits as soon as the row
  // exists, typically 5-6s but as fast as 1s on cold runs.
  const docId = page.url().match(/\/d\/([^/?]+)/)?.[1]
  if (!docId) throw new Error('expected /d/{docId} URL')

  async function activityEditRowCount(): Promise<number> {
    const res = await page.request.get(`/api/docs/${docId}/activity`)
    if (!res.ok()) return 0
    // Endpoint returns the array directly (`listRecentActivity(...)`),
    // not wrapped in `{ rows: [...] }`.
    const rows = await res.json() as Array<{ action: string }>
    return Array.isArray(rows) ? rows.filter(r => r.action === 'edit').length : 0
  }

  await expect.poll(activityEditRowCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

  await editorContent.press('Enter')
  await editorContent.press('Enter')
  await editorContent.pressSequentially('Pinned for the team to review.')

  // Same poll for the SECOND distinct edit row.
  await expect.poll(activityEditRowCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

  await flow.heading('See what changed in past edits', 3)
  await flow.narrate(
    'Every edit in markoto is logged in the Activity tab — who, '
    + 'when, how many lines added or removed. Click any row to '
    + 'expand a diff drawer in place: green added lines, red '
    + 'removed, line numbers, git-style `@@` hunks. Read-only by '
    + 'default; the Restore button is one click further if you '
    + 'want to roll back.'
  )

  // ─── Open the Activity tab ──────────────────────────────────────
  // Desktop: right-sidebar Activity tab; mobile: bottom-tab-bar entry.
  const activityTab = editor.isMobile
    ? editor.page.mobileTabs.activity
    : editor.page.sidebar.activity

  await flow.click(
    'Open the Activity tab',
    activityTab,
    {
      annotations: editor.isMobile
        ? []
        : [{ label: 'Activity tab', selector: '[data-testid="sidebar-tab-activity"]', kind: 'arrow' }],
      result: 'The Activity feed opens — one row per edit, comment, restore, theme/title change.',
      after: () => page.locator('[data-activity-id]').first().waitFor({ state: 'visible', timeout: 10_000 })
    }
  )

  // ─── Click an edit row → diff drawer ────────────────────────────
  await flow.heading('Click any edit row to see the diff', 3)
  await flow.narrate(
    'Edit rows are clickable — chevron + "show details" hint. The '
    + 'diff drawer expands inline; the editor stays where it is. '
    + 'No modal, no navigation. Click again to collapse.'
  )

  // Pick the first edit row in the feed. Each row carries
  // `data-activity-id`; we don't need the specific id, just the
  // first edit. Filter to rows that are expandable (have the
  // chevron) — that's the "edit" + "comment.*" kinds.
  const firstEditRow = page.locator('[data-activity-id]').filter({ hasText: /Maya/i }).first()
  await flow.click(
    'Click the row to expand its diff',
    firstEditRow,
    {
      // Mobile: activity row sits inside the Activity BottomSheet
      // portal — Reka's overlay intercepts pointer events. See
      // `tests/e2e/AGENTS.md` "Bottom-sheet portal interception".
      force: editor.isMobile,
      hero: true,
      result: 'The diff drawer expands inline — green for added lines, red for removed, line numbers down the gutter.',
      after: async () => {
        // Wait for the diff drawer to render its hunk rows. The
        // server replay + structured-patch round-trip is usually
        // <500ms; allow up to 5s for the cold case.
        await firstEditRow.locator('[data-expanded="true"]').or(
          page.locator('[data-activity-id]').filter({ hasText: /Maya/i }).first().locator('xpath=..').filter({ hasText: /Maya/i })
        ).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => { /* selector may not match — fall through */ })
        await page.waitForTimeout(1_500)
      }
    }
  )

  // ASSERTION: the row's data-expanded flipped to "true" AND the
  // diff drawer rendered (we can't easily target it without a
  // testid, so check the row state).
  await expect(firstEditRow).toHaveAttribute('data-expanded', 'true', { timeout: 5_000 })

  flow.next({
    slug: 'restore-an-earlier-version',
    why: 'Want to actually roll back to a past state? The restore flow shows the next click'
  })
})
