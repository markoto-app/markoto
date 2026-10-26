import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { readEmbeddingColumnDims } from '../../../server/utils/embeddingColumn'

// The default (hosted) embeddings path must be unchanged by the
// self-hoster configuration work: Jina deployment still registered in the
// real proxy, column still 768 after the boot-time reconciliation plugin ran
// in the spawned app, and the deep health check reports the embeddings
// component as ok.

describe('embeddings configuration (default = Jina @ 768)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('the proxy registers both the Jina default and the operator-configurable deployment', async () => {
    const res = await fetch('http://127.0.0.1:4100/v1/models', {
      headers: { authorization: 'Bearer sk-test-litellm-master' }
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    const ids = body.data.map(m => m.id)
    expect(ids).toContain('jina-embeddings-v5-text-nano')
    expect(ids).toContain('custom-embeddings')
  })

  it('leaves the knowledge vector column at the 768-d default', async () => {
    expect(await readEmbeddingColumnDims(testDb())).toBe(768)
  })

  it('GET /api/health/deep reports the embeddings component as ok', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/health/deep')
    // Overall status depends on which sidecars the test stack runs; the
    // embeddings check must be ok either way and never gate the status.
    const body = await res.json() as { checks: { embeddings: { status: string, error?: string } } }
    expect(body.checks.embeddings).toMatchObject({ status: 'ok' })
  })
})
