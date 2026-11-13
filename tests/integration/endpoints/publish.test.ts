import { readdirSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BASE_URL, TEST_BILLING_OFF_BASE_URL, TEST_PUBLISH_PAGES_HOST } from '../setup/env'

// Publish as a web page: the owner / workspace admins publish a
// static snapshot at /p/<slug>; it runs no script, its images are copies,
// the document itself keeps its access mode.

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:8334',
  region: 'us-east-1',
  credentials: { accessKeyId: 'ypad-access-key', secretAccessKey: 'ypad-secret-key' },
  forcePathStyle: true
})
const PNG = new Uint8Array(readFileSync('public/markoto-logos/app-icon-light.png'))

async function setContent(docId: string, content: string): Promise<void> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, content)
  await testDb().query(`INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`, [docId, Buffer.from(Y.encodeStateAsUpdate(ydoc))])
}

async function addImage(docId: string, ownerId: number): Promise<string> {
  const fileId = `img${Math.random().toString(36).slice(2, 10)}.png`
  const key = `docs/${docId}/${fileId}`
  await s3.send(new PutObjectCommand({ Bucket: 'ypad', Key: key, Body: PNG, ContentType: 'image/png' }))
  await testDb().query(
    `INSERT INTO uploads (doc_id, file_id, uploader_id, content_type, size_bytes, s3_key, confirmed_at) VALUES ($1, $2, $3, 'image/png', $4, $5, now())`,
    [docId, fileId, ownerId, PNG.byteLength, key]
  )
  return fileId
}

async function publishedKeys(pageId: string): Promise<string[]> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: 'ypad', Prefix: `published/${pageId}/` }))
  return (list.Contents ?? []).map(o => o.Key!)
}

interface PublishView { published: boolean, page: { slug: string, url: string, indexable: boolean } | null }

describe('publish as a web page', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('publishes a private document as a script-free page with copied images; the document stays private', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private', title: 'Field notes' })
    const fileId = await addImage(doc.docId, owner.id)
    await setContent(doc.docId, `# Field notes\n\nThe heron came back on Tuesday.\n\n![heron](/api/files/${doc.docId}/${fileId})\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>\n`)
    const client = await loggedInClient(owner.id)

    const res = await client.post(`/api/docs/${doc.docId}/publish`, {})
    expect(res.status, await res.clone().text()).toBe(200)
    const view = await res.json() as PublishView
    expect(view.published).toBe(true)
    expect(view.page!.slug).toMatch(/^field-notes-[a-z0-9]{6}$/)
    expect(view.page!.url).toMatch(new RegExp(`/p/${view.page!.slug}$`))
    // No pages host on this server: the page lives on the instance's own origin.
    expect(view.page!.url.startsWith(TEST_BASE_URL)).toBe(true)

    const page = await anonClient().get(`/p/${view.page!.slug}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('on Tuesday.')
    expect(html).toContain('<title>Field notes</title>')
    // Raw HTML in markdown is text, never markup.
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img[^>]*onerror/i)
    expect(html).not.toContain('token=')
    expect(html).toContain('noindex')
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toContain(`default-src 'none'`)
    expect(csp).not.toContain('script-src')
    expect(csp).toContain('sandbox')
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')

    // The image is a copy under the page, served publicly.
    expect(html).not.toContain(`/api/files/${doc.docId}/`)
    const src = /src="(\/api\/published\/[A-Za-z0-9_-]{16}\/files\/[^"]+)"/.exec(html)?.[1]
    expect(src).toBeTruthy()
    const img = await anonClient().get(src!)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    // Only the page itself loads its files, from the host that serves it.
    expect(img.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(img.headers.get('access-control-allow-origin')).toBeNull()

    // The document is as private as before.
    const token = await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null }
    expect(token.token).toBeNull()
    const audit = await testDb().query(`SELECT action FROM audit_log WHERE action = 'doc.published'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('owner and workspace admins only', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const admin = await createUser()
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, title: 'Team page' })
    await setContent(doc.docId, '# Team page\n\nHello.\n')
    expect((await anonClient().post(`/api/docs/${doc.docId}/publish`, {})).status).toBe(401)
    expect((await (await loggedInClient(editor.id)).post(`/api/docs/${doc.docId}/publish`, {})).status).toBe(403)
    expect((await (await loggedInClient(editor.id)).get(`/api/docs/${doc.docId}/publish`)).status).toBe(403)
    expect((await (await loggedInClient(admin.id)).post(`/api/docs/${doc.docId}/publish`, {})).status).toBe(200)
  })

  it('chosen address, renaming, conflicts, indexing', async () => {
    const owner = await createUser()
    const a = await createDoc({ ownerId: owner.id, title: 'A' })
    const b = await createDoc({ ownerId: owner.id, title: 'B' })
    await setContent(a.docId, '# A\n\nFirst.\n')
    await setContent(b.docId, '# B\n\nSecond.\n')
    const client = await loggedInClient(owner.id)
    expect((await client.post(`/api/docs/${a.docId}/publish`, { slug: 'Bad Slug' })).status).toBe(400)
    expect((await client.post(`/api/docs/${a.docId}/publish`, { slug: 'quarterly-letter' })).status).toBe(200)
    const taken = await client.post(`/api/docs/${b.docId}/publish`, { slug: 'quarterly-letter' })
    expect(taken.status).toBe(409)
    expect((await taken.json() as { data: { code: string } }).data.code).toBe('publish/slug-taken')

    const renamed = await client.patch(`/api/docs/${a.docId}/publish`, { slug: 'letter-q3', indexable: true })
    expect(renamed.status).toBe(200)
    expect((await anonClient().get('/p/quarterly-letter')).status).toBe(404)
    const page = await anonClient().get('/p/letter-q3')
    expect(page.status).toBe(200)
    expect(page.headers.get('x-robots-tag')).toBeNull()
    const html = await page.text()
    expect(html).toContain('<meta name="robots" content="index, follow">')
    expect(html).toMatch(/<link rel="canonical" href="[^"]+\/p\/letter-q3">/)
    expect((await client.patch(`/api/docs/${b.docId}/publish`, { indexable: true })).status).toBe(404)
  })

  it('re-publishing replaces the snapshot at the same address', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, title: 'Log' })
    await setContent(doc.docId, '# Log\n\nDay one.\n')
    const client = await loggedInClient(owner.id)
    const first = await (await client.post(`/api/docs/${doc.docId}/publish`, {})).json() as PublishView
    await setContent(doc.docId, '\n\nDay two.\n')
    const second = await (await client.post(`/api/docs/${doc.docId}/publish`, {})).json() as PublishView
    expect(second.page!.slug).toBe(first.page!.slug)
    expect(await (await anonClient().get(`/p/${first.page!.slug}`)).text()).toContain('Day two.')
  })

  it('unpublishing and deleting the document take the page and its files down', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, title: 'Gone soon' })
    const fileId = await addImage(doc.docId, owner.id)
    await setContent(doc.docId, `# Gone soon\n\n![x](/api/files/${doc.docId}/${fileId})\n`)
    const client = await loggedInClient(owner.id)
    const view = await (await client.post(`/api/docs/${doc.docId}/publish`, {})).json() as PublishView
    const html = await (await anonClient().get(`/p/${view.page!.slug}`)).text()
    const src = /src="(\/api\/published\/[^"]+)"/.exec(html)![1]!
    const pageId = src.split('/')[3]!
    expect((await publishedKeys(pageId)).length).toBe(1)

    expect((await client.delete(`/api/docs/${doc.docId}/publish`)).status).toBe(200)
    expect((await anonClient().get(`/p/${view.page!.slug}`)).status).toBe(404)
    expect((await anonClient().get(src)).status).toBe(404)
    expect(await publishedKeys(pageId)).toEqual([])

    const again = await (await client.post(`/api/docs/${doc.docId}/publish`, {})).json() as PublishView
    const againId = /src="\/api\/published\/([^/]+)\//.exec(await (await anonClient().get(`/p/${again.page!.slug}`)).text())![1]!
    expect((await publishedKeys(againId)).length).toBe(1)
    expect((await client.delete(`/api/docs/${doc.docId}`)).status).toBeLessThan(300)
    expect((await anonClient().get(`/p/${again.page!.slug}`)).status).toBe(404)
    expect(await publishedKeys(againId)).toEqual([])
  })

  it('a report filed from the page reaches moderation, and restricting the document takes the page down', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view', title: 'Reported page' })
    const fileId = await addImage(doc.docId, owner.id)
    await setContent(doc.docId, `# Reported page\n\n![x](/api/files/${doc.docId}/${fileId})\n`)
    const view = await (await (await loggedInClient(owner.id)).post(`/api/docs/${doc.docId}/publish`, {})).json() as PublishView
    const html = await (await anonClient().get(`/p/${view.page!.slug}`)).text()
    const pageId = /src="\/api\/published\/([^/]+)\//.exec(html)![1]!

    // The page's Report link carries the page address, not /d/<id>.
    const reporter = await createUser()
    const filed = await (await loggedInClient(reporter.id)).request('/api/abuse-reports', {
      method: 'POST',
      body: { contentUrl: view.page!.url, category: 'illegal_content', body: 'This page breaks the rules.', goodFaith: true }
    })
    expect(filed.status, await filed.clone().text()).toBeLessThan(300)
    const report = await testDb().query<{ report_id: string, doc_id: string | null }>(`SELECT report_id, doc_id FROM abuse_reports`)
    expect(report.rows[0]!.doc_id).toBe(doc.docId)

    const admin = await createUser()
    await testDb().query(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id])
    const decided = await (await loggedInClient(admin.id)).request(`/api/admin/abuse-reports/${report.rows[0]!.report_id}`, {
      method: 'PATCH',
      body: { status: 'actioned', decision: { action: 'access_restricted', rule: 'spam_or_seo', explanation: 'Spam page, access restricted.' } }
    })
    expect(decided.status, await decided.clone().text()).toBe(200)
    expect((await anonClient().get(`/p/${view.page!.slug}`)).status).toBe(404)
    expect(await publishedKeys(pageId)).toEqual([])
    const row = await testDb().query<{ access_mode: string }>(`SELECT access_mode FROM documents WHERE doc_id = $1`, [doc.docId])
    expect(row.rows[0]!.access_mode).toBe('private')
  })

  it('a moderation restriction sticks until an admin lifts it, also on copies', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const guest = await createUser()
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const otherWs = await createWorkspace(owner.id)
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view', title: 'Reported page', workspaceId: ws.workspaceId })
    await setContent(doc.docId, '# Reported page\n\nSpam.\n')
    const client = await loggedInClient(owner.id)
    await testDb().query(`INSERT INTO document_shares (doc_id, user_id, access, granted_by_user_id) VALUES ($1, $2, 'view', $3)`, [doc.docId, guest.id, owner.id])
    expect((await client.post(`/api/docs/${doc.docId}/publish`, {})).status).toBe(200)

    const reporter = await createUser()
    await (await loggedInClient(reporter.id)).request('/api/abuse-reports', {
      method: 'POST',
      body: { contentUrl: `/d/${doc.docId}`, category: 'illegal_content', body: 'This page breaks the rules.', goodFaith: true }
    })
    const report = await testDb().query<{ report_id: string }>(`SELECT report_id FROM abuse_reports`)
    const admin = await createUser()
    await testDb().query(`UPDATE users SET is_admin = true WHERE id = $1`, [admin.id])
    const adminClient = await loggedInClient(admin.id)
    const decided = await adminClient.request(`/api/admin/abuse-reports/${report.rows[0]!.report_id}`, {
      method: 'PATCH',
      body: { status: 'actioned', decision: { action: 'access_restricted', rule: 'spam_or_seo', explanation: 'Spam page, access restricted.' } }
    })
    expect(decided.status, await decided.clone().text()).toBe(200)
    const shares = await testDb().query(`SELECT 1 FROM document_shares WHERE doc_id = $1`, [doc.docId])
    expect(shares.rowCount).toBe(0)

    const refused = async (res: Response) => {
      expect(res.status, await res.clone().text()).toBe(403)
      // The client shows the code's text (apiErrors.moderation.restricted); no per-route key.
      expect((await res.json() as { data?: Record<string, unknown> }).data).toEqual({ code: 'moderation/restricted' })
    }
    await refused(await client.post(`/api/docs/${doc.docId}/publish`, {}))
    await refused(await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-view' }))
    await refused(await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'open-edit' }))
    await refused(await client.post(`/api/docs/${doc.docId}/password`, { action: 'set', password: 'correct horse battery' }))
    await refused(await client.post(`/api/docs/${doc.docId}/password`, { action: 'remove' }))
    await refused(await client.put(`/api/docs/${doc.docId}/shares`, { userId: guest.id, access: 'view' }))
    await refused(await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: otherWs.workspaceId }))
    // Narrowing and ordinary edits still work.
    expect((await client.put(`/api/docs/${doc.docId}/meta`, { accessMode: 'private', title: 'Renamed' })).status).toBe(200)
    expect((await client.patch(`/api/docs/${doc.docId}/workspace`, { workspaceId: null })).status).toBe(200)

    // A copy carries the restriction.
    const copy = await client.post(`/api/docs/${doc.docId}/duplicate`, { workspaceId: null })
    expect(copy.status, await copy.clone().text()).toBe(200)
    const copyId = (await copy.json() as { docId: string }).docId
    await refused(await client.put(`/api/docs/${copyId}/meta`, { accessMode: 'open-view' }))

    // Only a platform admin lifts it, with a note; then the owner may publish again.
    expect((await client.request(`/api/admin/documents/${doc.docId}/moderation-restriction`, { method: 'DELETE', body: { note: 'x' } })).status).toBe(403)
    expect((await adminClient.request(`/api/admin/documents/${doc.docId}/moderation-restriction`, { method: 'DELETE', body: {} })).status).toBe(400)
    const lifted = await adminClient.request(`/api/admin/documents/${doc.docId}/moderation-restriction`, { method: 'DELETE', body: { note: 'Appeal upheld.' } })
    expect(lifted.status, await lifted.clone().text()).toBe(200)
    const audit = await testDb().query<{ action: string }>(`SELECT action FROM audit_log WHERE scope_id = $1 AND action = 'doc.moderation_restriction_lifted'`, [doc.docId])
    expect(audit.rowCount).toBe(1)
    expect((await client.post(`/api/docs/${doc.docId}/publish`, {})).status).toBe(200)
    // The copy is still restricted.
    await refused(await client.put(`/api/docs/${copyId}/meta`, { accessMode: 'open-view' }))
  })
})

/** A plain HTTP request to the hosted-shaped server with a chosen Host header (fetch can't set Host). */
function onTwin(host: string, path: string, opts: { method?: string, cookie?: string } = {}): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
  const url = new URL(TEST_BILLING_OFF_BASE_URL)
  const headers: Record<string, string> = { host }
  if (opts.cookie) headers.cookie = opts.cookie
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

// The hosted-shaped server serves published pages from their own host
// (NUXT_PUBLISH_PAGES_HOST): user-written HTML never shares the app's
// origin, the app's /p/<slug> redirects there, and the pages host is
// nothing but published pages, no app, no API, no cookie.
/** What a browser would never send here (the session cookie is host-only on the app): forged or stale. */
const STALE_COOKIES = 'nuxt-session=stale; markoto-anon=x; ypad_locale=de'

describe('publish on a separate pages host', () => {
  const appHost = new URL(TEST_BILLING_OFF_BASE_URL).host

  beforeEach(async () => {
    await resetDb()
  })

  async function published(): Promise<{ ownerId: number, docId: string, slug: string, pageId: string }> {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private', title: 'Ferry times' })
    const fileId = await addImage(doc.docId, owner.id)
    await setContent(doc.docId, `# Ferry times\n\nThe ferry leaves at seven.\n\n![ferry](/api/files/${doc.docId}/${fileId})\n`)
    // Rendered by the primary (same database); served by the twin.
    const res = await (await loggedInClient(owner.id)).post(`/api/docs/${doc.docId}/publish`, {})
    expect(res.status, await res.clone().text()).toBe(200)
    const slug = (await res.json() as PublishView).page!.slug
    const pageId = (await testDb().query<{ id: string }>(`SELECT id FROM published_pages WHERE doc_id = $1`, [doc.docId])).rows[0]!.id
    return { ownerId: owner.id, docId: doc.docId, slug, pageId }
  }

  it('names the pages host as the page\'s address and redirects the app\'s /p/<slug> there', async () => {
    const { ownerId, docId, slug, pageId } = await published()
    const view = await (await (await loggedInClient(ownerId, undefined, TEST_BILLING_OFF_BASE_URL)).get(`/api/docs/${docId}/publish`)).json() as PublishView
    expect(view.page!.url).toBe(`https://${TEST_PUBLISH_PAGES_HOST}/p/${slug}`)

    const onApp = await onTwin(appHost, `/p/${slug}?utm_source=x`)
    expect(onApp.status).toBe(301)
    expect(onApp.headers.location).toBe(`https://${TEST_PUBLISH_PAGES_HOST}/p/${slug}`)
    expect(onApp.body).not.toContain('seven.')
    const file = await onTwin(appHost, `/api/published/${pageId}/files/nothing.png`)
    expect(file.status).toBe(301)
    expect(file.headers.location).toBe(`https://${TEST_PUBLISH_PAGES_HOST}/api/published/${pageId}/files/nothing.png`)
    // An address that can't be a page stays the app's (its own 404).
    expect((await onTwin(appHost, '/p/X')).status).toBe(404)
  })

  it('serves the page on the pages host under the published CSP, with no cookie', async () => {
    const { slug, pageId } = await published()
    // A stale session cookie sent to the pages host must not be answered with a fresh one.
    const page = await onTwin(TEST_PUBLISH_PAGES_HOST, `/p/${slug}`, { cookie: STALE_COOKIES })
    expect(page.status).toBe(200)
    expect(page.body).toContain('seven.</p>')
    expect(page.body).not.toMatch(/<script/i)
    expect(String(page.headers['content-security-policy'])).toContain(`default-src 'none'`)
    expect(String(page.headers['content-security-policy'])).toContain('sandbox')
    expect(page.headers['set-cookie']).toBeUndefined()
    expect(page.body).toContain('<meta name="robots" content="noindex, nofollow">')

    // Its images load from the same host, same-origin only.
    const src = new RegExp(`src="(/api/published/${pageId}/files/[^"]+)"`).exec(page.body)![1]!
    const img = await onTwin(TEST_PUBLISH_PAGES_HOST, src, { cookie: STALE_COOKIES })
    expect(img.status).toBe(200)
    expect(img.headers['content-type']).toBe('image/png')
    expect(img.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(img.headers['access-control-allow-origin']).toBeUndefined()
    expect(img.headers['set-cookie']).toBeUndefined()

    const robots = await onTwin(TEST_PUBLISH_PAGES_HOST, '/robots.txt')
    expect(robots.status).toBe(200)
    expect(robots.body).toContain('Disallow: /api/')
  })

  it('the pages host serves nothing of the app', async () => {
    const { slug } = await published()
    for (const path of ['/', '/api/health', '/api/_auth/session', '/d/x', '/pricing', '/_nuxt/x.js', '/auth/github', '/api/internal/traefik/custom-domains', '/p/', '/p/no-such-page', `/p/${slug}/x`]) {
      const res = await onTwin(TEST_PUBLISH_PAGES_HOST, path, { cookie: STALE_COOKIES })
      expect(res.status, path).toBe(404)
      expect(res.headers['set-cookie'], path).toBeUndefined()
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of [`/p/${slug}`, '/api/_auth/session', '/_nuxt/x.js']) {
        const res = await onTwin(TEST_PUBLISH_PAGES_HOST, path, { method, cookie: STALE_COOKIES })
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.headers['set-cookie'], `${method} ${path}`).toBeUndefined()
      }
    }
  })

  it('no response on the pages host carries a cookie, whoever answers it', async () => {
    const { pageId } = await published()
    // Answered by Nitro's static-asset handler (before any middleware), by
    // a handler's own error, or as a page, never with a cookie.
    const asset = readdirSync('.output/public/_nuxt').find(f => f.endsWith('.js'))!
    const cases: Array<[string, number]> = [
      [`/_nuxt/${asset}`, 200],
      ['/favicon.ico', 200],
      ['/robots.txt', 200],
      [`/api/published/${pageId}/files/nothing.png`, 404],
      ['/api/published/not-a-page-id/files/x.png', 404]
    ]
    for (const [path, status] of cases) {
      const res = await onTwin(TEST_PUBLISH_PAGES_HOST, path, { cookie: STALE_COOKIES })
      expect(res.status, path).toBe(status)
      expect(res.headers['set-cookie'], path).toBeUndefined()
    }
  })
})
