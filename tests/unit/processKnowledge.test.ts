import { describe, it, expect, vi, beforeEach } from 'vitest'

// processKnowledge is a fire-and-forget pipeline: fetch S3 → markitdown
// parse → chunk → embed → DB bulk insert → flip status to ready → delete
// original. Every phase has a failure mode the test suite needs to pin,
// because the integration path runs in the subprocess (invisible to
// coverage) AND the sweep plugin re-kicks stuck rows — so a subtle
// regression where we leave a row in `processing` forever, or flip to
// `ready` without inserting chunks, would only surface via user
// complaints.

// ─── Mocks ────────────────────────────────────────────────────────────────

/**
 * Per-test-programmable results for each Drizzle terminal call. The SUT
 * uses:
 *   - db.select(...).from(...).where(...).limit(1)       → row lookup
 *   - db.select({id}).from(...).where(...).limit(1)       → rowStillExists
 *   - db.delete(...).where(...)                           → deletion
 *   - db.insert(...).values(...)                          → chunk insert
 *   - db.update(...).set(...).where(...)                  → status flip
 *
 * We queue results for each terminal method and let the chain pass
 * through every intermediate .from/.where/.limit/etc.
 */
const selectQueue: unknown[][] = []
const updateCalls: Array<{ set: unknown, whereArg?: unknown }> = []
const insertCalls: Array<{ values: unknown }> = []
const deleteCalls: Array<{ table?: unknown, whereArg?: unknown }> = []

function makeDbChain() {
  const limit = async () => {
    const next = selectQueue.shift()
    return next ?? []
  }
  const where = () => ({ limit })
  const from = () => ({ where })

  // select(...) → chain; select itself is identity-ish for our purposes.
  const select = () => ({ from })

  // update(table).set(set).where(where) → resolves after `.where`.
  const update = () => ({
    set: (setValue: unknown) => {
      const call: { set: unknown, whereArg?: unknown } = { set: setValue }
      updateCalls.push(call)
      return {
        where: (whereArg: unknown) => {
          call.whereArg = whereArg
          return Promise.resolve()
        }
      }
    }
  })

  // insert(table).values(rows) → resolves directly.
  const insert = () => ({
    values: (values: unknown) => {
      insertCalls.push({ values })
      return Promise.resolve()
    }
  })

  // delete(table).where(where) → resolves.
  const del = (table: unknown) => {
    const call: { table: unknown, whereArg?: unknown } = { table }
    deleteCalls.push(call)
    return {
      where: (whereArg: unknown) => {
        call.whereArg = whereArg
        return Promise.resolve()
      }
    }
  }

  return { select, update, insert, delete: del }
}

const db = makeDbChain()
vi.mock('../../server/utils/database', () => ({
  useDatabase: () => db
}))

const chunkMarkdown = vi.fn<(md: string, opts: { maxChunks: number }) => Array<{ index: number, content: string, tokens: number }>>()
vi.mock('../../server/utils/chunkMarkdown', () => ({ chunkMarkdown }))

const embedDocuments = vi.fn<(chunks: string[], opts: unknown) => Promise<number[][]>>()
const resolveEmbeddingsConfig = vi.fn(() => ({ model: 'gemini-embedding-2-preview', dims: 768, apiKey: 'x' }))
const embeddingVersionTag = vi.fn(() => 'gemini-embedding-2-preview:768')
vi.mock('../../server/utils/embeddings', () => ({
  embedDocuments,
  resolveEmbeddingsConfig,
  embeddingVersionTag
}))

const sentryCaptureException = vi.fn()
vi.mock('@sentry/nuxt', () => ({ captureException: sentryCaptureException }))

const tryAcquireSessionLock = vi.fn<(namespace: string, key: string, ttlMs: number) => Promise<boolean>>()
const releaseSessionLock = vi.fn<(namespace: string, key: string) => Promise<void>>()
vi.mock('../../server/utils/rateLimit', () => ({
  tryAcquireSessionLock,
  releaseSessionLock
}))

const s3Send = vi.fn<(cmd: unknown) => Promise<unknown>>()
vi.stubGlobal('useS3Client', () => ({ send: s3Send }))

const runtimeConfig = {
  markitdownUrl: 'http://markitdown:8080',
  s3: { bucket: 'test-bucket' },
  knowledge: { maxChunksPerFile: 300 }
}
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
vi.stubGlobal('fetch', fetchMock)

const { processKnowledge } = await import('../../server/utils/processKnowledge')

// ─── Helpers ──────────────────────────────────────────────────────────────

type RowStatus = 'processing' | 'ready' | 'failed'

interface KRow {
  knowledgeId: string
  workspaceId: string
  s3Key: string
  sourceExt: string
  status: RowStatus
}

function row(overrides: Partial<KRow> = {}): KRow {
  return {
    knowledgeId: 'k1',
    workspaceId: 'w1',
    s3Key: 'workspaces/w1/knowledge/k1.pdf',
    sourceExt: 'pdf',
    status: 'processing',
    ...overrides
  }
}

function okResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as unknown as Response
}

function errResponse(status: number, body: string): Response {
  return { ok: false, status, text: async () => body } as unknown as Response
}

beforeEach(() => {
  selectQueue.length = 0
  updateCalls.length = 0
  insertCalls.length = 0
  deleteCalls.length = 0
  chunkMarkdown.mockReset()
  embedDocuments.mockReset()
  sentryCaptureException.mockReset()
  s3Send.mockReset()
  s3Send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) }
  }))
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => okResponse('# default markdown'))
  tryAcquireSessionLock.mockReset()
  tryAcquireSessionLock.mockResolvedValue(true)  // Default: every test gets the lock.
  releaseSessionLock.mockReset()
  releaseSessionLock.mockResolvedValue(undefined)
})

// ─── Tests ────────────────────────────────────────────────────────────────

describe('processKnowledge — short-circuit paths', () => {
  it('no-ops when the row is not found (sweep-deleted between enqueue and run)', async () => {
    selectQueue.push([])
    await processKnowledge('missing')
    expect(s3Send).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it('no-ops when the row is already ready (re-entrant safety)', async () => {
    // A re-run by the sweep plugin shouldn't redo work + re-delete S3.
    selectQueue.push([row({ status: 'ready' })])
    await processKnowledge('k1')
    expect(s3Send).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no-ops when the row is already failed (don\'t retry-in-place)', async () => {
    selectQueue.push([row({ status: 'failed' })])
    await processKnowledge('k1')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('processKnowledge — row deletion during pipeline', () => {
  it('aborts cleanly when the row is deleted during conversion (no markFailed)', async () => {
    // Initial row fetch (found, processing) — conversion runs — then the
    // rowStillExists check returns [] so we skip markFailed and everything
    // downstream. If we markFailed here we'd flip a DELETED row's ghost
    // shadow in a txn that'd FK-cascade-error anyway.
    selectQueue.push([row()])           // initial select
    selectQueue.push([])                // rowStillExists → gone
    fetchMock.mockResolvedValueOnce(okResponse('# body'))

    await processKnowledge('k1')

    expect(chunkMarkdown).not.toHaveBeenCalled()
    expect(embedDocuments).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it('aborts cleanly when the row is deleted during embedding (after embed cost)', async () => {
    // We paid the embedding cost but the user deleted the row — don't
    // try to INSERT chunks with a knowledgeId that no longer exists.
    selectQueue.push([row()])           // initial select
    selectQueue.push([{ id: 'k1' }])    // first rowStillExists → exists
    selectQueue.push([])                // second rowStillExists → gone
    fetchMock.mockResolvedValueOnce(okResponse('# body'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'body', tokens: 2 }])
    embedDocuments.mockResolvedValueOnce([[0.1, 0.2]])

    await processKnowledge('k1')

    // Embedding ran (cost paid) but no DB writes followed.
    expect(embedDocuments).toHaveBeenCalledOnce()
    expect(insertCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(0)
  })
})

describe('processKnowledge — content-quality failures', () => {
  it('markFailed on empty markdown (markitdown produced nothing useful)', async () => {
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('   \n\t\n  '))

    await processKnowledge('k1')

    // Status flipped to failed with a specific message.
    expect(updateCalls).toHaveLength(1)
    const { set } = updateCalls[0]!
    expect(set).toMatchObject({ status: 'failed', errorMessage: 'markitdown produced empty markdown' })
    expect(embedDocuments).not.toHaveBeenCalled()
  })

  it('markFailed when the chunker returns zero chunks', async () => {
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('# some content'))
    chunkMarkdown.mockReturnValueOnce([])

    await processKnowledge('k1')

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.set).toMatchObject({
      status: 'failed',
      errorMessage: 'no chunks produced from parsed content'
    })
    expect(embedDocuments).not.toHaveBeenCalled()
  })
})

describe('processKnowledge — happy path', () => {
  it('writes chunks + flips to ready + deletes S3 original', async () => {
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])   // first rowStillExists
    selectQueue.push([{ id: 'k1' }])   // second rowStillExists
    fetchMock.mockResolvedValueOnce(okResponse('# Hello\n\nBody'))
    chunkMarkdown.mockReturnValueOnce([
      { index: 0, content: '# Hello', tokens: 3 },
      { index: 1, content: 'Body', tokens: 1 }
    ])
    embedDocuments.mockResolvedValueOnce([[0.1, 0.2], [0.3, 0.4]])

    await processKnowledge('k1')

    // Chunks deleted-then-inserted (pre-clean).
    expect(deleteCalls).toHaveLength(1)
    expect(insertCalls).toHaveLength(1)
    const values = insertCalls[0]!.values as Array<Record<string, unknown>>
    expect(values).toHaveLength(2)
    expect(values[0]).toMatchObject({
      knowledgeId: 'k1',
      workspaceId: 'w1',
      chunkIndex: 0,
      content: '# Hello',
      tokens: 3,
      embedding: [0.1, 0.2]
    })
    expect(values[1]).toMatchObject({
      chunkIndex: 1,
      embedding: [0.3, 0.4]
    })

    // Status update: ready + counters + markdown_cache + embeddingVersion.
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.set).toMatchObject({
      status: 'ready',
      chunkCount: 2,
      tokenCount: 4,
      markdownCache: '# Hello\n\nBody',
      embeddingVersion: 'gemini-embedding-2-preview:768',
      errorMessage: null
    })

    // Two S3 calls: GetObject (fetch bytes) + DeleteObject (cleanup).
    expect(s3Send).toHaveBeenCalledTimes(2)
  })

  it('passes maxChunksPerFile from runtime config to the chunker', async () => {
    // The sentinel cap lives in knowledge config; a refactor that
    // forgets to thread it through would let a 25 MB txt file produce
    // unbounded chunks and embed cost.
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('# content'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'x', tokens: 1 }])
    embedDocuments.mockResolvedValueOnce([[0.1]])

    await processKnowledge('k1')

    expect(chunkMarkdown).toHaveBeenCalledWith('# content', { maxChunks: 300 })
  })
})

describe('processKnowledge — post-success S3 cleanup failure', () => {
  it('swallows S3 delete failure (row stays ready) and reports to Sentry', async () => {
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('# body'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'body', tokens: 1 }])
    embedDocuments.mockResolvedValueOnce([[0.1]])

    // First s3Send = GetObject (fetch bytes) — succeeds.
    // Second s3Send = DeleteObject (cleanup) — fails.
    s3Send
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) }
      })
      .mockRejectedValueOnce(new Error('S3 AccessDenied'))

    await processKnowledge('k1')

    // Row still flipped to ready.
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.set).toMatchObject({ status: 'ready' })

    // Sentry captured with the specific event tag.
    expect(sentryCaptureException).toHaveBeenCalledOnce()
    const [err, opts] = sentryCaptureException.mock.calls[0]!
    expect((err as Error).message).toBe('S3 AccessDenied')
    expect(opts).toMatchObject({
      tags: {
        component: 'processKnowledge',
        event: 'post_success_s3_delete_failed',
        knowledgeId: 'k1'
      }
    })
  })
})

describe('processKnowledge — pipeline exceptions', () => {
  it('markFailed when markitdown returns non-2xx (message slice preserves prefix)', async () => {
    selectQueue.push([row()])
    fetchMock.mockResolvedValueOnce(errResponse(502, 'Gateway timeout: markitdown-server unreachable'))

    await processKnowledge('k1')

    expect(updateCalls).toHaveLength(1)
    const errMsg = (updateCalls[0]!.set as { errorMessage: string }).errorMessage
    expect(errMsg).toContain('markitdown returned 502')
    expect(errMsg).toContain('Gateway timeout')
    // Sentry fires with pipeline_failed event, not empty-markdown or chunks-empty.
    expect(sentryCaptureException.mock.calls[0]?.[1]).toMatchObject({
      tags: expect.objectContaining({ event: 'pipeline_failed' })
    })
  })

  it('markFailed when embedDocuments throws (e.g. Gemini API error)', async () => {
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('# body'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'body', tokens: 1 }])
    embedDocuments.mockRejectedValueOnce(new Error('Gemini rate limit: 429'))

    await processKnowledge('k1')

    expect(updateCalls).toHaveLength(1)
    expect((updateCalls[0]!.set as { status: string }).status).toBe('failed')
    expect((updateCalls[0]!.set as { errorMessage: string }).errorMessage).toContain('Gemini rate limit')
  })

  it('truncates error messages longer than 500 chars (DB column sanity)', async () => {
    selectQueue.push([row()])
    // Huge error blob — if we wrote the full thing we'd waste bytes +
    // potentially blow a bytea/text column limit on exotic Postgres
    // configs. 500 chars is plenty to diagnose from.
    const hugeMsg = 'X'.repeat(5000)
    fetchMock.mockRejectedValueOnce(new Error(hugeMsg))

    await processKnowledge('k1')

    expect(updateCalls).toHaveLength(1)
    const errMsg = (updateCalls[0]!.set as { errorMessage: string }).errorMessage
    expect(errMsg.length).toBe(500)
    expect(errMsg).toBe('X'.repeat(500))
  })

  it('markFailed when markitdown URL is missing (config error surfaces cleanly)', async () => {
    const original = runtimeConfig.markitdownUrl
    runtimeConfig.markitdownUrl = ''
    try {
      selectQueue.push([row()])
      await processKnowledge('k1')
      expect(updateCalls).toHaveLength(1)
      expect((updateCalls[0]!.set as { errorMessage: string }).errorMessage)
        .toContain('markitdown service not configured')
    } finally {
      runtimeConfig.markitdownUrl = original
    }
  })
})

// ─── Adversarial tests ────────────────────────────────────────────────────
//
// Senior-QA review of the original 14 tests noted they were specification-
// style (re-verifying happy-path shapes). The tests below are hypothesis-
// driven: each one names a plausible failure mode and tries to trigger it.
// Where the SUT's current behaviour diverges from what we'd want, the test
// documents the gap as a failing hypothesis (a TODO for the codebase, not
// a test bug).

describe('processKnowledge — adversarial: non-Error throwables', () => {
  it('handles a thrown string (surfaces via String(e), no crash)', async () => {
    // Catch blocks in JS receive anything — including `throw "boom"`
    // from third-party code. The SUT does `e instanceof Error ? … : String(e)`.
    // Pin that a string throwable reaches markFailed with the literal,
    // not `[object Object]`.
    selectQueue.push([row()])
    // Make the markitdown fetch throw a string.
    fetchMock.mockImplementationOnce(() => { throw 'markitdown exploded' })

    await processKnowledge('k1')

    expect(updateCalls).toHaveLength(1)
    expect((updateCalls[0]!.set as { errorMessage: string }).errorMessage)
      .toBe('markitdown exploded')
  })

  it('handles a thrown null (String(null) = "null", still reaches markFailed)', async () => {
    // A library that does `throw null` or `throw undefined` would crash
    // a `.message` access. Pin graceful handling.
    selectQueue.push([row()])
    fetchMock.mockImplementationOnce(() => { throw null })

    await processKnowledge('k1')

    expect(updateCalls).toHaveLength(1)
    // Hypothesis: the SUT stringifies null as "null" and markFailed-s.
    // Alternative: it crashes. Both are observable via the test.
    expect((updateCalls[0]!.set as { status: string, errorMessage: string }))
      .toMatchObject({ status: 'failed', errorMessage: 'null' })
  })
})

describe('processKnowledge — embedding/chunk length mismatch (guarded)', () => {
  it('markFailed cleanly when embed returns FEWER vectors than chunks', async () => {
    // Adversarial test that originally documented a bug: `embeddings[i]!`
    // with a non-null assertion passed `undefined` to the drizzle insert
    // when Gemini dropped a vector. The SUT now has a length-check guard;
    // the test now verifies the guard works.
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('# a\n\n# b\n\n# c'))
    chunkMarkdown.mockReturnValueOnce([
      { index: 0, content: 'a', tokens: 1 },
      { index: 1, content: 'b', tokens: 1 },
      { index: 2, content: 'c', tokens: 1 }
    ])
    embedDocuments.mockResolvedValueOnce([[0.1], [0.2]]) // 2 vectors for 3 chunks

    await processKnowledge('k1')

    // No malformed insert issued.
    expect(insertCalls).toHaveLength(0)
    // Row flipped to failed with a descriptive message.
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]!.set).toMatchObject({
      status: 'failed',
      errorMessage: 'embed returned 2 vectors for 3 chunks'
    })
  })

  it('markFailed when embed returns MORE vectors than chunks', async () => {
    // Symmetric case: strict equality means extras also fail. If future
    // embedding SDKs legitimately return extras (summary vectors?),
    // THIS test should be updated — but silently dropping them hides
    // a behaviour change.
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('# a'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'a', tokens: 1 }])
    embedDocuments.mockResolvedValueOnce([[0.1], [0.2], [0.3]])

    await processKnowledge('k1')

    expect(insertCalls).toHaveLength(0)
    expect(updateCalls[0]!.set).toMatchObject({
      status: 'failed',
      errorMessage: 'embed returned 3 vectors for 1 chunks'
    })
  })
})

describe('processKnowledge — adversarial: chunker returns unexpected indices', () => {
  it('stores chunker-reported `index`, NOT array position (trusts chunker)', async () => {
    // The code uses `c.index` for the stored chunkIndex. If the chunker
    // emits gappy/non-monotonic indices (bug or intentional), they land
    // in the DB as-is. This could collide with search/filter code that
    // assumes chunkIndex is 0..N-1 contiguous.
    //
    // Pin the current contract: chunker's `index` wins. If the
    // retrieval side starts assuming contiguity, it must also add a
    // chunker invariant or post-process the indices here.
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('body'))
    chunkMarkdown.mockReturnValueOnce([
      { index: 10, content: 'a', tokens: 1 },
      { index: 20, content: 'b', tokens: 1 }
    ])
    embedDocuments.mockResolvedValueOnce([[0.1], [0.2]])

    await processKnowledge('k1')

    const values = insertCalls[0]!.values as Array<{ chunkIndex: number }>
    expect(values.map(v => v.chunkIndex)).toEqual([10, 20])
  })

  it('stores duplicate chunkIndex values if the chunker produces them (no dedup)', async () => {
    // If the chunker duplicates an index by mistake, we INSERT both rows.
    // Search would return whichever Postgres orders first, or both. The
    // SUT does NOT validate uniqueness. Pin that so a regression either
    // (a) adds validation, (b) or explicitly flags the chunker bug.
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('body'))
    chunkMarkdown.mockReturnValueOnce([
      { index: 5, content: 'a', tokens: 1 },
      { index: 5, content: 'b', tokens: 1 }
    ])
    embedDocuments.mockResolvedValueOnce([[0.1], [0.2]])

    await processKnowledge('k1')

    const values = insertCalls[0]!.values as Array<{ chunkIndex: number }>
    expect(values.map(v => v.chunkIndex)).toEqual([5, 5])
  })
})

describe('processKnowledge — concurrency guarded by Valkey claim-check', () => {
  it('second concurrent call no-ops (Valkey lock held by first)', async () => {
    // Adversarial test that originally found a TOCTOU bug — the
    // `status !== 'processing'` guard let two concurrent calls both
    // proceed. The SUT now acquires a `knowledge-process:{id}` lock
    // via `tryAcquireSessionLock` before starting the pipeline; the
    // second caller can't acquire it and no-ops.
    //
    // We program the mock `tryAcquireSessionLock` (below) to return
    // true once then false — simulating "first call wins, second loses".
    // Under the old SUT this test would have failed with 2 embed
    // calls + 2 inserts.
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValue(okResponse('# body'))
    chunkMarkdown.mockReturnValue([{ index: 0, content: 'body', tokens: 1 }])
    embedDocuments.mockResolvedValue([[0.1]])
    // Lock acquisition: first call succeeds, second call fails.
    tryAcquireSessionLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await Promise.all([processKnowledge('k1'), processKnowledge('k1')])

    // Only ONE pipeline ran.
    expect(embedDocuments).toHaveBeenCalledTimes(1)
    expect(insertCalls.length).toBe(1)
    expect(updateCalls.length).toBe(1)
    // Second caller's lock acquisition was attempted (and refused).
    expect(tryAcquireSessionLock).toHaveBeenCalledTimes(2)
  })

  it('releases the lock in the finally block even on pipeline error', async () => {
    // Invariant: a pipeline that throws must still release the lock.
    // Otherwise a crashed worker would poison the knowledgeId for up
    // to 10 min (the TTL). Verify the release happens regardless of
    // success vs failure.
    tryAcquireSessionLock.mockResolvedValueOnce(true)
    selectQueue.push([row()])
    fetchMock.mockRejectedValueOnce(new Error('markitdown down'))

    await processKnowledge('k1')

    expect(releaseSessionLock).toHaveBeenCalledWith('knowledge-process', 'k1')
  })

  it('still releases the lock on the happy path', async () => {
    tryAcquireSessionLock.mockResolvedValueOnce(true)
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('body'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'body', tokens: 1 }])
    embedDocuments.mockResolvedValueOnce([[0.1]])

    await processKnowledge('k1')

    expect(releaseSessionLock).toHaveBeenCalledWith('knowledge-process', 'k1')
  })

  it('sweep-triggered re-process AFTER earlier success does nothing (belt + braces)', async () => {
    // Positive control: in the SERIAL case (T1 finishes, lock released,
    // T2 starts, acquires lock, reads status='ready'), T2 no-ops at the
    // `status !== 'processing'` check. Both guards are load-bearing:
    // the lock prevents concurrent runs, the status check prevents
    // re-running already-complete rows.
    tryAcquireSessionLock.mockResolvedValue(true)
    selectQueue.push([row()])
    selectQueue.push([{ id: 'k1' }])
    selectQueue.push([{ id: 'k1' }])
    fetchMock.mockResolvedValueOnce(okResponse('body'))
    chunkMarkdown.mockReturnValueOnce([{ index: 0, content: 'body', tokens: 1 }])
    embedDocuments.mockResolvedValueOnce([[0.1]])

    await processKnowledge('k1')
    expect(updateCalls).toHaveLength(1)

    // T2: lock available again, but status is now ready.
    selectQueue.push([row({ status: 'ready' })])
    await processKnowledge('k1')

    expect(embedDocuments).toHaveBeenCalledTimes(1)
    expect(insertCalls.length).toBe(1)
    expect(updateCalls.length).toBe(1)
  })
})
