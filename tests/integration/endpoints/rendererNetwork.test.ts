// SSRF lockdown for the renderer sidecar. The renderer's Chromium reaches the
// app container directly (no Traefik, so no CSP) and used to fetch ANY URL a
// document's markdown pointed at, internal services, cloud metadata, while
// producing a PDF/PNG. These tests plant two HTTP canaries on the host (the
// renderer reaches them via host.docker.internal, exactly like it reaches the
// app on :3101) and assert which of them a render touches:
//
//   - ALLOWED canary: its origin is listed in RENDERER_ALLOWED_ORIGINS on the
//     renderer-test service (deploy/compose/compose.test.yml). Positive control, it
//     proves the allowlist is configurable and that a render CAN fetch images.
//   - BLOCKED canary: an ephemeral port nobody allowed. Must see zero hits.
//
// Test stack required: postgres-test + valkey-test + seaweedfs-test +
// renderer-test (deploy/compose/compose.test.yml).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { resetDb, testDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'

// MUST match RENDERER_ALLOWED_ORIGINS on renderer-test in deploy/compose/compose.test.yml.
const ALLOWED_PORT = 3187

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

interface Canary {
  server: Server
  port: number
  hits: string[]
}

function startCanary(port: number, redirectTo?: () => string): Promise<Canary> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (redirectTo && req.url?.startsWith('/redirect')) {
      res.writeHead(302, { Location: redirectTo() })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length })
    res.end(PNG)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('canary has no TCP address'))
        return
      }
      resolve({ server, port: (addr as AddressInfo).port, hits })
    })
  })
}

async function insertYjsRow(docname: string, content: string): Promise<void> {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, content)
  await testDb().query(
    `INSERT INTO yjs_updates (doc_id, kind, data) VALUES ($1, 'update', $2)`,
    [docname, Buffer.from(Y.encodeStateAsUpdate(ydoc))]
  )
}

let allowed: Canary
let blocked: Canary

beforeAll(async () => {
  blocked = await startCanary(0)
  allowed = await startCanary(ALLOWED_PORT, () => `http://host.docker.internal:${blocked.port}/via-redirect.png`)
})

afterAll(async () => {
  await Promise.all([allowed, blocked].map(c => new Promise<void>(r => c.server.close(() => r()))))
})

beforeEach(async () => {
  await resetDb()
  allowed.hits.length = 0
  blocked.hits.length = 0
})

async function renderPdfWith(markdown: string | ((docId: string) => string)): Promise<number> {
  const owner = await createUser()
  const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
  await insertYjsRow(doc.docId, typeof markdown === 'string' ? markdown : markdown(doc.docId))
  const res = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
  return res.status
}

describe('renderer network lockdown (SSRF)', () => {
  it('fetches images from an origin on the allowlist (positive control)', async () => {
    const status = await renderPdfWith(`# Doc\n\n![ok](http://host.docker.internal:${allowed.port}/ok.png)\n`)
    expect(status).toBe(200)
    expect(allowed.hits).toContain('/ok.png')
  }, 90_000)

  it('never requests an origin outside the allowlist', async () => {
    const status = await renderPdfWith(`# Doc\n\n![evil](http://host.docker.internal:${blocked.port}/internal-secret.png)\n`)
    // A blocked image degrades to a broken image, the render itself succeeds.
    expect(status).toBe(200)
    expect(blocked.hits).toEqual([])
  }, 90_000)

  // The print page holds a file-access token for the document's own uploads. A URL that merely CONTAINS the
  // upload path (here on an allowed origin) must not get it: the token must not be appended to every
  // `/api/files/<docId>/…` substring match in the HTML.
  it('never hands the file-access token to a URL that only contains the doc\'s upload path', async () => {
    const status = await renderPdfWith(docId => `# Doc\n\n![t](http://host.docker.internal:${allowed.port}/api/files/${docId}/AbCdEfGhIjKl.png)\n`)
    expect(status).toBe(200)
    expect(allowed.hits).toHaveLength(1)
    expect(allowed.hits[0]).toMatch(/^\/api\/files\/[\w-]+\/AbCdEfGhIjKl\.png$/)
  }, 90_000)

  it('does not follow a redirect from an allowed origin to a blocked one', async () => {
    const status = await renderPdfWith(`# Doc\n\n![hop](http://host.docker.internal:${allowed.port}/redirect.png)\n`)
    expect(status).toBe(200)
    expect(allowed.hits).toContain('/redirect.png')
    expect(blocked.hits).toEqual([])
  }, 90_000)
})
