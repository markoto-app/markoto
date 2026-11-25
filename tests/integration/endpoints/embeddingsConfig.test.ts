import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { readEmbeddingColumnDims } from '../../../server/db/embeddingColumn'

// The default (hosted) embeddings path: the `mistral-embed` deployment is
// registered in the real proxy next to the operator-configurable one, the
// boot-time reconciliation plugin of the spawned app retyped the empty
// column from the migrations' 768 to the 1024-d default, and the deep
// health check reports the embeddings component as ok.

describe('embeddings configuration (default = mistral-embed @ 1024)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('the proxy registers both the mistral-embed default and the operator-configurable deployment', async () => {
    const res = await fetch('http://127.0.0.1:4100/v1/models', {
      headers: { authorization: 'Bearer sk-test-litellm-master' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    const ids = body.data.map(m => m.id)
    expect(ids).toContain('mistral-embed')
    expect(ids).toContain('custom-embeddings')
  })

  it('retypes the empty knowledge vector column to the 1024-d default at boot', async () => {
    expect(await readEmbeddingColumnDims(testDb())).toBe(1024)
  })

  it('GET /api/health/deep reports the embeddings component as ok', async () => {
    const u = await createUser()
    // Instance admins only: the probe errors name internal hosts.
    await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [u.id])
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/health/deep')
    // Overall status depends on which sidecars the test stack runs; the
    // embeddings check must be ok either way and never gate the status.
    const body = await res.json() as { checks: { embeddings: { status: string, error?: string } } }
    expect(body.checks.embeddings).toMatchObject({ status: 'ok' })
  })
})
