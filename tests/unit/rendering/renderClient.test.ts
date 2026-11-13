// Unit tests for renderClient.ts, the orchestrator that decides whether
// to short-circuit on a cached manifest or kick the renderer container.
//
// What we verify (the SPECIFIED behaviour, not the implementation):
//   - cache hit returns `cached: true` without calling the renderer
//   - a `both`-format cache satisfies both pdf and png requests
//
// More integration-shaped tests (singleflight, renderer-error surfacing)
// belong in tests/integration/ where the full lifecycle can be controlled
// end to end against a real Nitro process, vitest's stubGlobal lifecycle
// makes the singleflight Map's cross-test state hard to assert reliably
// from a unit test.
//
// Mocks: the typed env (stubbed), useS3Client, the database pool, Sentry.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubEnv } from '../../helpers/env'
import { renderDocument, __testing } from '../../../server/utils/rendering/renderClient'
import { docAs } from '../../helpers/access'

const RENDERER_URL = 'http://renderer:9000'
const SECRET = 'internal-api-secret-for-test-0123456789'
const BUCKET = 'ypad-test'

// renderClient imports useS3Client from `./s3` (explicit import), so a
// global stub doesn't intercept it, the module mock does.
const s3Send = vi.fn()
vi.mock('../../../server/utils/storage/s3', () => ({
  useS3Client: () => ({ send: s3Send })
}))

const dbQuery = vi.fn(async () => ({ rows: [{ id: 100 }] }))
vi.mock('../../../server/db/client', () => ({
  useDatabasePool: () => ({ query: dbQuery })
}))

vi.mock('@sentry/nuxt', () => ({
  captureException: vi.fn()
}))

// Records when the sync flush ran relative to the snapshot read.
const callOrder: string[] = []
const flushSyncDocument = vi.fn(async (_docId: string) => {
  callOrder.push('flush')
  return true
})
vi.mock('../../../server/utils/documents/syncNotify', () => ({
  flushSyncDocument: (docId: string) => flushSyncDocument(docId)
}))

// Global fetch is only read at function-call time inside the SUT, so the
// stub can be installed after the import.
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function manifest(format: 'pdf' | 'png' | 'both') {
  return {
    snapshotId: 100,
    pageCount: 3,
    format,
    renderedAt: '2026-04-30T00:00:00Z',
    pdfKey: format === 'png' ? null : 'renders/DOC/100/document.pdf',
    pageKeys: format === 'pdf' ? [] : ['renders/DOC/100/page-1.png']
  }
}

beforeEach(() => {
  stubEnv({
    NUXT_INTERNAL_API_SECRET: SECRET,
    NUXT_RENDERER_INTERNAL_URL: RENDERER_URL,
    NUXT_S3_BUCKET: BUCKET,
    NUXT_S3_ENDPOINT: 'http://s3',
    NUXT_S3_ACCESS_KEY: 'k',
    NUXT_S3_SECRET_KEY: 's'
  })
  __testing.inflight.clear()
  fetchMock.mockReset()
  dbQuery.mockReset()
  dbQuery.mockResolvedValue({ rows: [{ id: 100 }] })
  s3Send.mockReset()
  flushSyncDocument.mockClear()
  callOrder.length = 0
})

describe('renderClient.renderDocument: pending edits', () => {
  it('flushes the doc on the sync server before reading its snapshot', async () => {
    dbQuery.mockImplementation(async () => {
      callOrder.push('snapshot')
      return { rows: [{ id: 100 }] }
    })
    // Cache hit: HEAD + GET of the manifest.
    s3Send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify(manifest('pdf')) } })
    await renderDocument(docAs('DOC'), { format: 'pdf' })
    expect(flushSyncDocument).toHaveBeenCalledWith('DOC')
    expect(callOrder.slice(0, 2)).toEqual(['flush', 'snapshot'])
  })
})

describe('renderClient.renderDocument', () => {
  // Helper: hit-mode mock by call order. readManifest does HEAD then GET;
  // we feed those two calls in sequence and ignore everything after.
  function s3Cache(m: ReturnType<typeof manifest>) {
    let nth = 0
    s3Send.mockImplementation(async () => {
      nth++
      if (nth === 1) return {} // HEAD ok
      if (nth === 2) return { Body: { transformToString: async () => JSON.stringify(m) } }
      return {}
    })
  }

  function s3Miss() {
    s3Send.mockImplementation(async () => {
      const err = new Error('NotFound')
      err.name = 'NotFound'
      throw err
    })
  }

  it('returns cached:true when a matching manifest exists, without calling the renderer', async () => {
    s3Cache(manifest('pdf'))

    const result = await renderDocument(docAs('DOC'), { format: 'pdf' })

    expect(result.cached).toBe(true)
    expect(result.manifest.snapshotId).toBe(100)
    expect(result.manifest.format).toBe('pdf')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a `both`-format cached manifest as satisfying a pdf request', async () => {
    s3Cache(manifest('both'))

    const result = await renderDocument(docAs('DOC'), { format: 'pdf' })

    expect(result.cached).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a `both`-format cached manifest as satisfying a png request', async () => {
    s3Cache(manifest('both'))

    const result = await renderDocument(docAs('DOC'), { format: 'png' })

    expect(result.cached).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('on cache miss, POSTs the renderer with the right body + secret header', async () => {
    s3Miss()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ pageCount: 2, pdfKey: 'renders/DOC/100/document.pdf', pageKeys: [] })
    })

    const result = await renderDocument(docAs('DOC'), { format: 'pdf' })

    expect(result.cached).toBe(false)
    expect(result.manifest.pageCount).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${RENDERER_URL}/render`)
    const headers = init.headers as Record<string, string>
    expect(headers['X-Internal-Secret']).toBe(SECRET)
    const body = JSON.parse(init.body)
    expect(body).toEqual({ docId: 'DOC', snapshotId: 100, format: 'pdf' })
  })

  it('surfaces renderer errors as thrown exceptions', async () => {
    s3Miss()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'Render hard timeout' })
    })

    await expect(renderDocument(docAs('DOC'), { format: 'pdf' })).rejects.toThrow(/Renderer 502/)
  })
})
