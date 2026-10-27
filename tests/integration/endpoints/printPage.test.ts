// Integration smoke test for the internal print page route at
// /_internal/render/:docId. Hit by Playwright in the renderer
// container; we want a server-only test that catches regressions
// without requiring a real browser:
//
//   - The Vue route is reachable (didn't accidentally end up under a
//     guarded prefix or nest path).
//   - SSR runs without throwing (the page imports a chain of theme +
//     paged.js + markdown helpers; an import-time error here was the
//     hardest class of bug to catch in CI before this test).
//   - The bootstrap useFetch fires through SSR and shapes the auth
//     surface as expected (valid token → 200 + #render-mount marker;
//     bad token → 403 — Nuxt collapses the createError throw from
//     setup() into a 403 HTTP response).
//
// Browser-only behaviour (paged.js running, window.__pagedReady flipping
// to true, .pagedjs_page nodes existing) lives in renderer/src/render.ts
// and is exercised by the docPdf.test.ts integration suite when the
// renderer container is up. Keep this test scope to the SSR boundary so
// it remains fast and runnable without Playwright/Chromium.

import { describe, it, expect, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { resetDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'
import { TEST_INTERNAL_SECRET } from '../setup/env'
import { mintRenderJwt } from '~~/shared/test-helpers/jwt'

function mintRenderToken(docId: string, opts: {
  scope?: string
  ttl?: number
  secret?: string
} = {}): string {
  // Happy path goes through the shared `mintRenderJwt` so the wire
  // shape (`scope: 'render'` + 60s TTL) is pinned by the contract.
  // Adversarial cases (scope override, secret rotation, expired
  // tokens) take the raw `jwt.sign` branch — those are testing the
  // verifier's reject paths so they MUST be free to mint malformed
  // shapes.
  if (opts.scope === undefined && opts.secret === undefined && opts.ttl === undefined) {
    return mintRenderJwt({ docId, snapshotId: 1 }, { secret: TEST_INTERNAL_SECRET })
  }
  return jwt.sign(
    { docId, snapshotId: 1, scope: opts.scope ?? 'render' },
    opts.secret ?? TEST_INTERNAL_SECRET,
    { expiresIn: opts.ttl ?? 60 }
  )
}

beforeEach(async () => {
  await resetDb()
})

describe('GET /_internal/render/:docId (print page)', () => {
  it('returns SSR-rendered HTML for a valid render token', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, title: 'Smoke Doc' })
    const token = mintRenderToken(doc.docId)

    const res = await anonClient().get(
      `/_internal/render/${doc.docId}?t=${encodeURIComponent(token)}`
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    // The pre-mount placeholder div is the load-bearing SSR marker.
    // paged.js rips it out client-side, but on the SSR pass it should
    // be present — that's how we know the page mounted without
    // throwing during setup().
    expect(html).toContain('id="render-mount"')
  })

  it('sends a restrictive CSP (second layer behind the renderer allowlist)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId)

    const res = await anonClient().get(
      `/_internal/render/${doc.docId}?t=${encodeURIComponent(token)}`
    )

    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain('default-src \'none\'')
    // Images: own origin, data/blob, the S3 host + the operator's extra origin — nothing else.
    expect(csp).toContain('img-src \'self\' data: blob: http://127.0.0.1:8334 http://host.docker.internal:3187;')
    expect(csp).not.toMatch(/img-src[^;]*\*/)
  })

  it('does not put the render CSP on other pages', async () => {
    const res = await anonClient().get('/api/health')
    const csp = res.headers.get('content-security-policy') ?? ''
    // Every other response carries the app policy (server/plugins/csp.ts).
    expect(csp).toContain('default-src \'self\'')
    expect(csp).toContain('frame-ancestors \'none\'')
  })

  it('returns 403 when the render token is missing', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })

    const res = await anonClient().get(`/_internal/render/${doc.docId}`)
    // The bootstrap useFetch in setup() throws createError(403) when
    // no token is provided; Nuxt translates it to a 403 response.
    expect(res.status).toBe(403)
  })

  it('returns 403 on an expired render token', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const token = mintRenderToken(doc.docId, { ttl: -1 })

    const res = await anonClient().get(
      `/_internal/render/${doc.docId}?t=${encodeURIComponent(token)}`
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 on a token signed for a different doc', async () => {
    const ownerA = await createUser()
    const ownerB = await createUser()
    const docA = await createDoc({ ownerId: ownerA.id })
    const docB = await createDoc({ ownerId: ownerB.id })
    const tokenForA = mintRenderToken(docA.docId)

    const res = await anonClient().get(
      `/_internal/render/${docB.docId}?t=${encodeURIComponent(tokenForA)}`
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 on a token with the wrong scope', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    // Same shape as a render token but with a non-render scope —
    // exercises the defence-in-depth scope check in render-bootstrap.
    const token = mintRenderToken(doc.docId, { scope: 'file-access' })

    const res = await anonClient().get(
      `/_internal/render/${doc.docId}?t=${encodeURIComponent(token)}`
    )
    expect(res.status).toBe(403)
  })
})
