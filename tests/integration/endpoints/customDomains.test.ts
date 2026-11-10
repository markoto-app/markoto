import { request as httpRequest } from 'node:http'
import { connect as tlsConnect, type PeerCertificate } from 'node:tls'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ensureYjsTable, resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import {
  TEST_BASE_URL, TEST_BILLING_OFF_BASE_URL, TEST_CHALLTESTSRV_URL, TEST_PUBLISH_DOMAINS_TARGET,
  TEST_TRAEFIK_IP, TEST_TRAEFIK_PROVIDER_TOKEN, TEST_TRAEFIK_TLS_PORT
} from '../setup/env'

// Custom domains (WP13): a user adds a domain, proves it with a TXT
// record, points it at the instance; only then Traefik gets a router for
// it and a certificate from the ACME CA — here pebble, Let's Encrypt's
// test CA, with challtestsrv as DNS (docker-compose.test.yml). On the
// domain only the published page and its files exist.

interface DomainView {
  id: string
  hostname: string
  status: 'pending' | 'verified' | 'failed'
  problem: string | null
  dns: { txtName: string, txtValue: string, cnameTarget: string }
  page: { docId: string, slug: string } | null
}

const uniqueHost = () => `docs-${Math.random().toString(36).slice(2, 9)}.acme.test`

async function challtest(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${TEST_CHALLTESTSRV_URL}${path}`, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`challtestsrv ${path}: ${res.status}`)
}
const fqdn = (h: string) => `${h}.`

/** A plain HTTP request to the app with a chosen Host header (fetch can't set Host). */
function getWithHost(host: string, path: string, method = 'GET'): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
  const url = new URL(TEST_BASE_URL)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method, headers: { host } }, (res) => {
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

/** The certificate traefik-test presents for `host`, and the page it serves over TLS. */
function viaTraefik(host: string): Promise<{ cert: PeerCertificate, status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: TEST_TRAEFIK_TLS_PORT, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate()
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      let raw = ''
      socket.setEncoding('utf8')
      socket.on('data', (c: string) => {
        raw += c
      })
      socket.on('end', () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0)
        resolve({ cert, status, body: raw.slice(raw.indexOf('\r\n\r\n') + 4) })
      })
    })
    socket.on('error', reject)
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')))
  })
}

async function publishedDoc(ownerId: number, text: string): Promise<string> {
  const doc = await createDoc({ ownerId, title: 'Harbour guide' })
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, text)
  await testDb().query(`INSERT INTO yjs_documents (docname, value, version) VALUES ($1, $2, 'v1')`, [doc.docId, Buffer.from(Y.encodeStateAsUpdate(ydoc))])
  const res = await (await loggedInClient(ownerId)).post(`/api/docs/${doc.docId}/publish`, {})
  if (res.status !== 200) throw new Error(`publish: ${res.status} ${await res.text()}`)
  return doc.docId
}

/** Add a domain and make its DNS right (TXT + A records for it and the target). */
async function verifiedDomain(userId: number): Promise<DomainView> {
  const client = await loggedInClient(userId)
  const added = await (await client.post('/api/user/custom-domains', { hostname: uniqueHost() })).json() as DomainView
  await challtest('/set-txt', { host: fqdn(added.dns.txtName), value: added.dns.txtValue })
  await challtest('/add-a', { host: fqdn(added.hostname), addresses: [TEST_TRAEFIK_IP] })
  await challtest('/add-a', { host: fqdn(TEST_PUBLISH_DOMAINS_TARGET), addresses: [TEST_TRAEFIK_IP] })
  const checked = await (await client.post(`/api/user/custom-domains/${added.id}/verify`, {})).json() as DomainView
  expect(checked.status, JSON.stringify(checked)).toBe('verified')
  return checked
}

async function providerConfig(): Promise<{ http?: { routers?: Record<string, { rule: string, tls: { certResolver: string }, service: string }> } }> {
  const res = await fetch(`${TEST_BASE_URL}/api/internal/traefik/custom-domains`, { headers: { 'x-markoto-provider-token': TEST_TRAEFIK_PROVIDER_TOKEN } })
  expect(res.status).toBe(200)
  return await res.json() as never
}

beforeAll(async () => {
  await ensureYjsTable()
})

describe('custom domains', () => {
  beforeEach(async () => {
    await resetDb()
    await ensureYjsTable()
  })

  it('a domain is routed only after its TXT record and address check out', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    const add = await client.post('/api/user/custom-domains', { hostname: `HTTPS://${uniqueHost().toUpperCase()}/some/path` })
    expect(add.status).toBe(201)
    const domain = await add.json() as DomainView
    expect(domain.status).toBe('pending')
    expect(domain.hostname).toMatch(/^docs-[a-z0-9]+\.acme\.test$/)
    expect(domain.dns).toMatchObject({ txtName: `_markoto-verify.${domain.hostname}`, cnameTarget: TEST_PUBLISH_DOMAINS_TARGET })
    expect(domain.dns.txtValue).toMatch(/^markoto-verify=[A-Za-z0-9_-]{24}$/)

    const verify = async () => (await (await client.post(`/api/user/custom-domains/${domain.id}/verify`, {})).json() as DomainView)
    expect(await verify()).toMatchObject({ status: 'pending', problem: 'txt-missing' })
    await challtest('/set-txt', { host: fqdn(domain.dns.txtName), value: 'markoto-verify=someone-elses-token' })
    expect(await verify()).toMatchObject({ status: 'pending', problem: 'txt-mismatch' })
    await challtest('/set-txt', { host: fqdn(domain.dns.txtName), value: domain.dns.txtValue })
    expect(await verify()).toMatchObject({ status: 'pending', problem: 'not-pointing' })
    // Pointing somewhere else isn't enough …
    await challtest('/add-a', { host: fqdn(domain.hostname), addresses: ['10.213.47.99'] })
    await challtest('/add-a', { host: fqdn(TEST_PUBLISH_DOMAINS_TARGET), addresses: [TEST_TRAEFIK_IP] })
    expect(await verify()).toMatchObject({ status: 'pending', problem: 'not-pointing' })
    expect((await providerConfig()).http?.routers ?? {}).toEqual({})
    // … the instance's address is (challtestsrv appends: clear first).
    await challtest('/clear-a', { host: fqdn(domain.hostname) })
    await challtest('/add-a', { host: fqdn(domain.hostname), addresses: [TEST_TRAEFIK_IP] })
    expect(await verify()).toMatchObject({ status: 'verified', problem: null })

    const routers = Object.values((await providerConfig()).http!.routers!)
    expect(routers).toEqual([expect.objectContaining({ rule: `Host(\`${domain.hostname}\`)`, tls: { certResolver: 'pebble' }, service: 'markoto-published-pages' })])
    const audit = await testDb().query(`SELECT action FROM audit_log WHERE action LIKE 'custom_domain.%' ORDER BY id`)
    expect(audit.rows.map(r => r.action)).toEqual(['custom_domain.added', 'custom_domain.verified'])
  })

  it('refuses bad, own and taken names, other people\'s domains and pages, and needs the plan', async () => {
    const user = await createUser()
    const client = await loggedInClient(user.id)
    for (const bad of ['localhost', 'intranet', '10.0.0.1', 'docs.acme.test:8443', `x.${TEST_PUBLISH_DOMAINS_TARGET}`, TEST_PUBLISH_DOMAINS_TARGET, 'a.local']) {
      const res = await client.post('/api/user/custom-domains', { hostname: bad })
      expect(res.status, bad).toBe(400)
    }
    const mine = await (await client.post('/api/user/custom-domains', { hostname: uniqueHost() })).json() as DomainView
    expect((await client.post('/api/user/custom-domains', { hostname: mine.hostname })).status).toBe(409)
    const other = await createUser()
    const otherClient = await loggedInClient(other.id)
    expect((await otherClient.post(`/api/user/custom-domains/${mine.id}/verify`, {})).status).toBe(404)
    expect((await otherClient.delete(`/api/user/custom-domains/${mine.id}`)).status).toBe(404)
    expect(((await (await otherClient.get('/api/user/custom-domains')).json()) as { domains: unknown[] }).domains).toEqual([])

    // A domain can only show a page its owner may manage, and only a published one.
    const othersDoc = await publishedDoc(other.id, '# Not yours\n\nText.\n')
    expect((await client.patch(`/api/user/custom-domains/${mine.id}`, { docId: othersDoc })).status).toBe(403)
    const unpublished = await createDoc({ ownerId: user.id })
    const notPublished = await client.patch(`/api/user/custom-domains/${mine.id}`, { docId: unpublished.docId })
    expect(notPublished.status).toBe(409)

    // markoto.app free: no custom domains.
    const hosted = await loggedInClient(user.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const refused = await hosted.post('/api/user/custom-domains', { hostname: uniqueHost() })
    expect(refused.status).toBe(409)
    expect((await refused.json() as { data: { code: string } }).data.code).toBe('plan/feature-unavailable')
    expect((await (await hosted.get('/api/user/custom-domains')).json() as { available: boolean }).available).toBe(false)
  })

  it('an unproven claim never blocks the real owner; once verified, the name is taken', async () => {
    const squatter = await createUser()
    const squatterClient = await loggedInClient(squatter.id)
    const host = uniqueHost()
    const squat = await (await squatterClient.post('/api/user/custom-domains', { hostname: host })).json() as DomainView
    expect(squat.status).toBe('pending')

    // The real owner adds the same name and proves it with their own token.
    const owner = await createUser()
    const ownerClient = await loggedInClient(owner.id)
    const add = await ownerClient.post('/api/user/custom-domains', { hostname: host })
    expect(add.status).toBe(201)
    const real = await add.json() as DomainView
    expect(real.dns.txtValue).not.toBe(squat.dns.txtValue)
    await challtest('/set-txt', { host: fqdn(real.dns.txtName), value: real.dns.txtValue })
    await challtest('/add-a', { host: fqdn(host), addresses: [TEST_TRAEFIK_IP] })
    await challtest('/add-a', { host: fqdn(TEST_PUBLISH_DOMAINS_TARGET), addresses: [TEST_TRAEFIK_IP] })
    const verified = await (await ownerClient.post(`/api/user/custom-domains/${real.id}/verify`, {})).json() as DomainView
    expect(verified.status).toBe('verified')

    // The squatter's token isn't in DNS; even if it were, the name is taken now.
    await challtest('/set-txt', { host: fqdn(squat.dns.txtName), value: squat.dns.txtValue })
    const squatCheck = await (await squatterClient.post(`/api/user/custom-domains/${squat.id}/verify`, {})).json() as DomainView
    expect(squatCheck).toMatchObject({ status: 'pending', problem: 'in-use' })
    const third = await loggedInClient((await createUser()).id)
    expect((await third.post('/api/user/custom-domains', { hostname: host })).status).toBe(409)
    expect(Object.values((await providerConfig()).http!.routers!).map(r => r.rule)).toEqual([`Host(\`${host}\`)`])
  })

  it('the provider endpoint wants its token', async () => {
    expect((await fetch(`${TEST_BASE_URL}/api/internal/traefik/custom-domains`)).status).toBe(403)
    expect((await fetch(`${TEST_BASE_URL}/api/internal/traefik/custom-domains`, { headers: { 'x-markoto-provider-token': 'x'.repeat(40) } })).status).toBe(403)
    expect((await anonClient().get('/api/internal/traefik/custom-domains')).status).toBe(403)
  })

  it('on the domain only the page exists — no app, no API', async () => {
    const user = await createUser()
    const domain = await verifiedDomain(user.id)
    expect((await getWithHost(domain.hostname, '/')).body).toContain('Nothing is published on this domain yet.')
    const docId = await publishedDoc(user.id, '# Harbour guide\n\nThe ferry leaves at seven.\n')
    const client = await loggedInClient(user.id)
    const attached = await client.patch(`/api/user/custom-domains/${domain.id}`, { docId })
    expect(attached.status).toBe(200)
    expect((await attached.json() as DomainView).page?.docId).toBe(docId)

    const page = await getWithHost(domain.hostname, '/')
    expect(page.status).toBe(200)
    expect(page.body).toContain('seven.</p>')
    expect(String(page.headers['content-security-policy'])).toContain(`default-src 'none'`)
    expect(page.body).toContain('<meta name="robots" content="noindex, nofollow">')
    // The report form is on the instance; without a configured site URL
    // there is no instance address to link to from a foreign host.
    expect(page.body).not.toContain(`${domain.hostname}/legal/abuse`)
    for (const path of ['/d/whatever', '/api/user/custom-domains', '/api/health', '/pricing', '/_nuxt/x.js', '/p/whatever']) {
      expect((await getWithHost(domain.hostname, path)).status, path).toBe(404)
    }
    expect((await getWithHost(domain.hostname, '/', 'POST')).status).toBe(404)
    expect((await getWithHost(domain.hostname, '/robots.txt')).body).toContain('Disallow: /')
    // The /p/ page names the domain as its address.
    const slug = (await (await client.get(`/api/docs/${docId}/publish`)).json() as { page: { slug: string } }).page.slug
    await client.patch(`/api/docs/${docId}/publish`, { indexable: true })
    expect(await (await anonClient().get(`/p/${slug}`)).text()).toContain(`<link rel="canonical" href="https://${domain.hostname}/">`)
    expect((await getWithHost(domain.hostname, '/robots.txt')).body).toContain('Allow: /')

    // Removed: back to an unknown host for the app, gone from Traefik.
    expect((await client.delete(`/api/user/custom-domains/${domain.id}`)).status).toBe(200)
    expect((await providerConfig()).http?.routers ?? {}).toEqual({})
  })

  it('Traefik gets a certificate for a verified domain and serves the page over HTTPS', async () => {
    const user = await createUser()
    const domain = await verifiedDomain(user.id)
    const docId = await publishedDoc(user.id, '# Harbour guide\n\nTickets at the kiosk.\n')
    await (await loggedInClient(user.id)).patch(`/api/user/custom-domains/${domain.id}`, { docId })

    // Traefik polls every second (its backoff may still be winding down
    // from the app's start), then runs TLS-ALPN-01 against pebble.
    let result: Awaited<ReturnType<typeof viaTraefik>> | null = null
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      try {
        const r = await viaTraefik(domain.hostname)
        if (/pebble/i.test(String(r.cert.issuer?.CN ?? ''))) {
          result = r
          break
        }
      } catch { /* not routed yet */ }
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(result, 'no pebble certificate within 2 minutes').not.toBeNull()
    expect(result!.cert.subjectaltname).toContain(`DNS:${domain.hostname}`)
    expect(result!.status).toBe(200)
    expect(result!.body).toContain('Tickets at the kiosk.')
  }, 180_000)
})
