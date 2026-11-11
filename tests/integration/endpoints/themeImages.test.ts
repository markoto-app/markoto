import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'

// Theme image URLs (cover logo, header/footer image) are interpolated
// into an HTML attribute and a CSS url(). Regression: the schema only
// checked their length, so any string was stored. Now a write accepts
// empty, a bundled asset, or an upload of THIS document.

function themeWith(logoUrl: string, headerUrl = ''): typeof defaultTheme {
  return {
    ...defaultTheme,
    brand: { ...defaultTheme.brand, logoUrl },
    header: { ...defaultTheme.header, imageUrl: headerUrl }
  }
}

async function storedLogo(docId: string): Promise<string | undefined> {
  const r = await testDb().query<{ theme: { brand?: { logoUrl?: string } } | null }>(
    'SELECT theme FROM documents WHERE doc_id = $1', [docId]
  )
  return r.rows[0]?.theme?.brand?.logoUrl
}

describe('PUT /api/docs/:id/meta — theme image URLs', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('stores an upload of this document', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const url = `/api/files/${doc.docId}/AbCdEfGhIjKl.png`
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: themeWith(url, url) })
    expect(res.status).toBe(200)
    expect(await storedLogo(doc.docId)).toBe(url)
  })

  it('stores the bundled default logo', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: defaultTheme })
    expect(res.status).toBe(200)
  })

  it.each([
    'x" onerror="alert(1)',
    'https://example.test/logo.png',
    'javascript:alert(1)'
  ])('rejects a logo URL that is not an upload path (%s)', async (logoUrl) => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: themeWith(logoUrl) })
    expect(res.status).toBe(400)
    expect(await storedLogo(doc.docId)).not.toBe(logoUrl)
  })

  it('rejects another document\'s upload with theme/image-not-in-doc', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const client = await loggedInClient(owner.id)
    const res = await client.put(`/api/docs/${doc.docId}/meta`, { theme: themeWith('', '/api/files/someOtherDoc/AbCdEfGhIjKl.png') })
    expect(res.status).toBe(400)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('theme/image-not-in-doc')
  })
})
