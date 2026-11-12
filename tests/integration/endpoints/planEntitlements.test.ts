// Plan entitlements over real HTTP.
//
// The billing-off twin runs the hosted free-only shape, including the
// hosted free-tier plan limits (`HOSTED_FREE_TIER_LIMITS` in
// setup/server.ts = infra/render-env.sh): 3 members per workspace, 30 days
// of history, 3 saved themes, 10 MB imports, no custom CSS. The primary
// server keeps the committed (self-host) tier: every feature on, no limit,
// the cases at the end pin that nothing is limited there.
//
// Every refusal is 409 with `data.code` `plan/limit-reached` or
// `plan/feature-unavailable`, a `messageKey` and the coming-soon recovery
// link (billing off + plans coming soon).
//
// Test stack: postgres-test + valkey-test.

import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace } from '../setup/fixtures'
import { TEST_BASE_URL, TEST_BILLING_OFF_BASE_URL, TEST_INTERNAL_SECRET } from '../setup/env'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { THEME_PRESETS, themeFromPreset } from '~~/shared/utils/theme/themePresets'
import { mintRenderJwt } from '~~/tests/helpers/jwt'

const OFF = TEST_BILLING_OFF_BASE_URL

interface PlanErrorBody {
  data?: {
    code?: string
    field?: string
    feature?: string
    limit?: number
    messageKey?: string
    recovery?: { kind: string, href?: string, labelKey?: string }
  }
}

async function expectPlanError(res: Response, code: 'plan/limit-reached' | 'plan/feature-unavailable', key: string) {
  expect(res.status).toBe(409)
  const body = await res.json() as PlanErrorBody
  expect(body.data?.code).toBe(code)
  expect(body.data?.messageKey).toBe(key)
  // Billing off + plans coming soon → "paid plans coming soon" link.
  expect(body.data?.recovery).toEqual({ kind: 'link', href: '/pricing', labelKey: 'billing.comingSoonCta' })
  return body
}

let nextYjsId = 1

async function insertActivity(docId: string, ageDays: number): Promise<number> {
  // (doc_id, yjs_doc_id_after) is unique for edit rows, give each its own boundary ids.
  const before = nextYjsId++
  const after = nextYjsId++
  const r = await testDb().query<{ id: number }>(
    `INSERT INTO activity_log (doc_id, user_name, action, lines_added, lines_removed, yjs_doc_id_before, yjs_doc_id_after, created_at)
     VALUES ($1, 'Alice', 'edit', 1, 0, $3, $4, NOW() - ($2 || ' days')::interval)
     RETURNING id`,
    [docId, String(ageDays), before, after]
  )
  return r.rows[0]!.id
}

function importForm(bytes: number, name: string): FormData {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes).fill(97)]), name)
  return form
}

describe('plan entitlements: hosted free tier (billing-off server)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('members per workspace: creator + 2 invitations fit, a third is refused', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id, undefined, OFF)

    for (const email of ['a@example.test', 'b@example.test']) {
      const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email })
      expect(res.status, email).toBe(202)
    }
    // Re-inviting an address already invited refreshes it, no new seat.
    expect((await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'a@example.test' })).status).toBe(202)

    const res = await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email: 'c@example.test' })
    const body = await expectPlanError(res, 'plan/limit-reached', 'plan.limit.membersPerWorkspace')
    expect(body.data?.field).toBe('membersPerWorkspace')
    expect(body.data?.limit).toBe(3)
  })

  it('saved themes: three fit, the fourth is refused', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id, undefined, OFF)
    for (let i = 1; i <= 3; i++) {
      const res = await client.post('/api/themes', { name: `Theme ${i}`, theme: defaultTheme })
      expect(res.status, `theme ${i}`).toBe(200)
    }
    const res = await client.post('/api/themes', { name: 'Theme 4', theme: defaultTheme })
    const body = await expectPlanError(res, 'plan/limit-reached', 'plan.limit.savedThemes')
    expect(body.data?.limit).toBe(3)
  })

  it('custom CSS: new CSS is refused, unchanged stored CSS still saves, the token reports the feature off', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id, undefined, OFF)

    const refused = await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: 'p { color: #123456 }' } })
    const body = await expectPlanError(refused, 'plan/feature-unavailable', 'plan.feature.customCss')
    expect(body.data?.feature).toBe('customCss')

    // A theme without custom CSS saves normally.
    expect((await client.put(`/api/docs/${doc.docId}/meta`, { theme: defaultTheme })).status).toBe(200)

    // CSS already stored (from before the limit, or via Y.js) is paused, not
    // blocking: sending the same CSS back with other theme changes works.
    const stored = 'h1 { color: #654321 }'
    await testDb().query('UPDATE documents SET theme = $2 WHERE doc_id = $1', [doc.docId, JSON.stringify({ ...defaultTheme, customCss: stored })])
    expect((await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: stored } })).status).toBe(200)

    const token = await (await client.get(`/api/docs/${doc.docId}/token`)).json() as { planFeatures?: { customCss?: boolean } }
    expect(token.planFeatures).toEqual({ customCss: false })
  })

  it('custom CSS: a built-in preset\'s template CSS is not gated, it saves and reaches the PDF; the author\'s own CSS is dropped there', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id, undefined, OFF)
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')
    if (!arxiv?.theme.customCss) throw new Error('arxiv preset without template CSS')
    const template = arxiv.theme.customCss.trim()

    // Picking the preset (what ThemeEditorPanel sends) saves on the free tier.
    expect((await client.put(`/api/docs/${doc.docId}/meta`, { theme: themeFromPreset(arxiv, undefined) })).status).toBe(200)
    // Adding the author's own CSS after it is refused.
    const withOwn = themeFromPreset(arxiv, '.paged-doc p { color: #123456; }')
    await expectPlanError(await client.put(`/api/docs/${doc.docId}/meta`, { theme: withOwn }), 'plan/feature-unavailable', 'plan.feature.customCss')

    // Stored with own CSS (e.g. via Y.js): the PDF path keeps the template only.
    await testDb().query('UPDATE documents SET theme = $2 WHERE doc_id = $1', [doc.docId, JSON.stringify(withOwn)])
    const t = mintRenderJwt({ docId: doc.docId, snapshotId: 1 }, { secret: TEST_INTERNAL_SECRET })
    const res = await anonClient(OFF).get(`/api/_internal/render-bootstrap?docId=${doc.docId}&t=${t}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { theme: { customCss?: string } }
    expect(body.theme.customCss).toBe(template)
  })

  it('history window: older rows are hidden from the feed and their diff is refused', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const recent = await insertActivity(doc.docId, 1)
    const old = await insertActivity(doc.docId, 45)
    const client = await loggedInClient(owner.id, undefined, OFF)

    const feed = await client.get(`/api/docs/${doc.docId}/activity`)
    expect(feed.status).toBe(200)
    expect(feed.headers.get('x-markoto-history-limited-days')).toBe('30')
    const rows = await feed.json() as Array<{ id: number }>
    expect(rows.map(r => r.id)).toEqual([recent])

    const diff = await client.get(`/api/docs/${doc.docId}/activity/${old}/diff`)
    const body = await expectPlanError(diff, 'plan/limit-reached', 'plan.limit.historyEntry')
    expect(body.data?.field).toBe('historyDays')

    // Restore of the old row is refused the same way (before any replay).
    const restore = await client.post(`/api/docs/${doc.docId}/activity/${old}/restore`, {})
    await expectPlanError(restore, 'plan/limit-reached', 'plan.limit.historyEntry')

    // The row is still stored.
    const stillThere = await testDb().query('SELECT 1 FROM activity_log WHERE id = $1', [old])
    expect(stillThere.rowCount).toBe(1)
  })

  it('history window: no header when nothing is hidden', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertActivity(doc.docId, 2)
    const client = await loggedInClient(owner.id, undefined, OFF)
    const feed = await client.get(`/api/docs/${doc.docId}/activity`)
    expect(feed.headers.get('x-markoto-history-limited-days')).toBeNull()
  })

  it('import size: a file over 10 MB is refused for the plan, before any conversion', async () => {
    const res = await fetch(`${OFF}/api/import`, { method: 'POST', body: importForm(11 * 1024 * 1024, 'big.docx') })
    const body = await expectPlanError(res, 'plan/limit-reached', 'plan.limit.importMaxBytes')
    expect(body.data?.limit).toBe(10 * 1024 * 1024)
  })
})

describe('plan entitlements: committed self-host tier (primary server)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('reports custom CSS on and stores it', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: { ...defaultTheme, customCss: 'p { color: #123456 }' } })
    expect(res.status).toBe(200)
    const token = await (await client.get(`/api/docs/${doc.docId}/token`)).json() as { planFeatures?: { customCss?: boolean } }
    expect(token.planFeatures).toEqual({ customCss: true })
  })

  it('shows the whole history', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    await insertActivity(doc.docId, 1)
    await insertActivity(doc.docId, 400)
    const client = await loggedInClient(owner.id)
    const feed = await client.get(`/api/docs/${doc.docId}/activity`)
    expect(feed.headers.get('x-markoto-history-limited-days')).toBeNull()
    expect((await feed.json() as unknown[]).length).toBe(2)
  })

  it('allows more than three workspace invitations', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    for (const email of ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test']) {
      expect((await client.post(`/api/workspaces/${ws.workspaceId}/members`, { email })).status, email).toBe(202)
    }
  })

  it('does not apply the 10 MB import limit', async () => {
    const res = await fetch(`${TEST_BASE_URL}/api/import`, { method: 'POST', body: importForm(11 * 1024 * 1024, 'big.docx') })
    expect(res.status).not.toBe(409)
  })
})
