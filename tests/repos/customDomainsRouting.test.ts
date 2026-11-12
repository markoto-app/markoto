import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, removeMember, setMemberRole } from '../integration/setup/fixtures'
import { listVerifiedCustomDomains } from '../../server/repos/customDomains'

// The routing table must stop showing a page once the domain's owner can
// no longer manage the document behind it (the right is only checked when
// the page is attached). `pageManageable` is computed in one query for the
// whole table; these cases pin it against the rules of `getDocAuthz`.

let seq = 0

async function domainShowing(userId: number, docId: string | null): Promise<string> {
  seq += 1
  let pageId: string | null = null
  if (docId) {
    // A document has at most one published page: domains of different
    // users that show the same document share it.
    const existing = await testDb().query<{ id: string }>(`SELECT id FROM published_pages WHERE doc_id = $1`, [docId])
    pageId = existing.rows[0]?.id ?? `page${seq}`
    if (!existing.rows[0]) {
      await testDb().query(
        `INSERT INTO published_pages (id, doc_id, slug, title, html, css) VALUES ($1, $2, $3, 't', '', '')`,
        [pageId, docId, `slug-${seq}`]
      )
    }
  }
  const id = `dom${seq}`
  await testDb().query(
    `INSERT INTO custom_domains (id, hostname, user_id, page_id, verify_token, status, verified_at) VALUES ($1, $2, $3, $4, 'tok', 'verified', now())`,
    [id, `d${seq}.example.test`, userId, pageId]
  )
  return id
}

async function manageable(domainId: string): Promise<boolean> {
  const row = (await listVerifiedCustomDomains()).find(d => d.id === domainId)
  if (!row) throw new Error(`domain ${domainId} not listed`)
  return row.pageManageable
}

describe('listVerifiedCustomDomains: pageManageable', () => {
  beforeEach(async () => {
    await resetDb()
  })
  // The integration server shares this database, and traefik-test polls
  // its routing table every second (cached 15 s): verified domains left
  // behind here would show up in the custom-domain suite's provider config.
  afterAll(async () => {
    await resetDb()
  })

  it('a domain without a page has nothing to lose', async () => {
    const user = await createUser()
    expect(await manageable(await domainShowing(user.id, null))).toBe(true)
  })

  it('the owner of a standalone document keeps it; anyone else never had it', async () => {
    const owner = await createUser()
    const other = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    expect(await manageable(await domainShowing(owner.id, doc.docId))).toBe(true)
    expect(await manageable(await domainShowing(other.id, doc.docId))).toBe(false)
  })

  it('handing the document over takes it away from the former owner', async () => {
    const owner = await createUser()
    const next = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const domain = await domainShowing(owner.id, doc.docId)
    await testDb().query(`UPDATE documents SET owner_id = $1 WHERE doc_id = $2`, [next.id, doc.docId])
    expect(await manageable(domain)).toBe(false)
  })

  it('a workspace admin keeps it while admin, loses it when demoted or removed', async () => {
    const owner = await createUser()
    const admin = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const domain = await domainShowing(admin.id, doc.docId)
    expect(await manageable(domain)).toBe(true)

    await setMemberRole(ws.workspaceId, admin.id, 'editor')
    expect(await manageable(domain)).toBe(false)

    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    expect(await manageable(domain)).toBe(true)
    await removeMember(ws.workspaceId, admin.id)
    expect(await manageable(domain)).toBe(false)
  })

  it('moving the document into a workspace the domain owner does not run takes it away', async () => {
    const admin = await createUser()
    const owner = await createUser()
    const wsA = await createWorkspace(admin.id)
    const wsB = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, workspaceId: wsA.workspaceId })
    const domain = await domainShowing(admin.id, doc.docId)
    expect(await manageable(domain)).toBe(true)
    await testDb().query(`UPDATE documents SET workspace_id = $1 WHERE doc_id = $2`, [wsB.workspaceId, doc.docId])
    expect(await manageable(domain)).toBe(false)
  })

  it('in a workspace that enforces single sign-on, the owner counts only as a member', async () => {
    const admin = await createUser()
    const owner = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, owner.id, 'editor')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId })
    const domain = await domainShowing(owner.id, doc.docId)
    await testDb().query(
      `INSERT INTO sso_connections (id, workspace_id, protocol, status) VALUES ('sso1', $1, 'oidc', 'active')`,
      [ws.workspaceId]
    )
    // A member without a fresh sign-in grant: still theirs (grants last
    // 12 hours; a page must not go dark between sign-ins).
    expect(await manageable(domain)).toBe(true)
    // Deprovisioned (SCIM removes the membership): gone.
    await removeMember(ws.workspaceId, owner.id)
    expect(await manageable(domain)).toBe(false)
  })
})
