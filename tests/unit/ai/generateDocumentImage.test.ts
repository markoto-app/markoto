import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetaToolContext } from '../../../server/utils/agentic/toolContext'

// `generateDocumentImage`: the one code path behind the AI's / MCP's
// `generate_image` and the editor's "Generate image with AI". Provider,
// S3 and the uploads repo are faked; the integration suite runs the real
// thing (tests/integration/endpoints/aiProviders.test.ts).

const h = vi.hoisted(() => ({
  generateImageBytes: vi.fn(),
  sumImageBytesInScope: vi.fn(),
  reservePendingUpload: vi.fn(),
  deletePending: vi.fn(),
  markConfirmed: vi.fn(),
  getDoc: vi.fn(),
  s3Send: vi.fn()
}))

vi.mock('../../../server/utils/ai/tools/imageGeneration', () => ({
  IMAGE_MIME_EXT: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' },
  generateImageBytes: h.generateImageBytes
}))
vi.mock('../../../server/repos/uploads', () => ({
  sumImageBytesInScope: h.sumImageBytesInScope,
  reservePendingUpload: h.reservePendingUpload,
  deletePending: h.deletePending,
  markConfirmed: h.markConfirmed
}))
vi.mock('../../../server/repos/documents', () => ({ getDoc: h.getDoc }))
vi.mock('../../../server/utils/storage/imageQuota', () => ({
  resolveImageQuota: async () => ({ maxBytes: 1000, scope: { kind: 'user', userId: 7 } }),
  imageQuotaMessage: (max: number) => `Image storage full (${max} bytes).`
}))
vi.mock('../../../server/utils/storage/s3', () => ({ useS3Client: () => ({ send: h.s3Send }) }))
vi.mock('~~/shared/env/load', () => ({ useEnv: () => ({ storage: { bucket: 'test-bucket' } }) }))
vi.mock('@sentry/nuxt', () => ({ captureException: vi.fn() }))

const { generateDocumentImage, generateImageTool } = await import('../../../server/utils/ai/tools/imageTools')

const writeProof = { docId: 'doc12345', allows: () => true }
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    docId: 'doc12345',
    initiatorUserId: 7,
    workspaceId: null,
    self: { userId: 7 },
    docAccess: writeProof,
    workspaceAccess: null,
    sessionId: 's1',
    attributedTo: 'user:7',
    plan: 'free',
    periodStart: new Date(),
    virtualKey: 'sk-virtual',
    aiProviders: { chat: null, image: { capability: 'image', source: 'instance', model: 'flux-3-image-klein', credentials: null, supportsVision: false }, transcription: null, worker: null },
    updateStatus: vi.fn(),
    ...overrides
  } as unknown as MetaToolContext
}
const REQUEST = { prompt: 'a lighthouse', alt: 'A [lighthouse]', width: 1344, height: 768 }
const PNG = { bytes: new Uint8Array(200), mimeType: 'image/png' }

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.sumImageBytesInScope.mockResolvedValue(0)
  h.getDoc.mockResolvedValue({ docId: 'doc12345' })
  h.reservePendingUpload.mockResolvedValue({ reserved: true })
  h.generateImageBytes.mockResolvedValue(PNG)
  h.s3Send.mockResolvedValue({})
  h.deletePending.mockResolvedValue(undefined)
  h.markConfirmed.mockResolvedValue(undefined)
})

describe('generateDocumentImage', () => {
  it('stores the image as an upload of the document and returns its Markdown', async () => {
    const res = await generateDocumentImage(ctx(), REQUEST)
    if (!res.ok) throw new Error('expected success')
    expect(res.url).toMatch(/^\/api\/files\/doc12345\/[\w-]{12}\.png$/)
    expect(res.markdown).toBe(`![A lighthouse](${res.url})`)
    expect(h.generateImageBytes).toHaveBeenCalledWith('a lighthouse', expect.any(AbortSignal), expect.objectContaining({ width: 1344, height: 768, virtualKey: 'sk-virtual', userId: 7, docId: 'doc12345' }))
    expect(h.reservePendingUpload).toHaveBeenCalledWith(writeProof, expect.objectContaining({ uploaderId: 7, contentType: 'image/png', sizeBytes: 200 }), 1000, expect.anything())
    expect(h.markConfirmed).toHaveBeenCalledOnce()
  })

  it('a full image storage refuses before generating (no AI budget spent)', async () => {
    h.sumImageBytesInScope.mockResolvedValue(1000)
    expect(await generateDocumentImage(ctx(), REQUEST)).toEqual({ ok: false, failure: { kind: 'storage-quota', maxBytes: 1000 } })
    expect(h.generateImageBytes).not.toHaveBeenCalled()
  })

  it('a reservation that no longer fits is a storage-quota failure too', async () => {
    h.reservePendingUpload.mockResolvedValue({ reserved: false })
    expect(await generateDocumentImage(ctx(), REQUEST)).toEqual({ ok: false, failure: { kind: 'storage-quota', maxBytes: 1000 } })
    expect(h.s3Send).not.toHaveBeenCalled()
  })

  it('passes a provider failure through, budget kind included', async () => {
    const failure = { error: 'Your AI Points are used up.', budget: 'personal' }
    h.generateImageBytes.mockResolvedValue(failure)
    expect(await generateDocumentImage(ctx(), REQUEST)).toEqual({ ok: false, failure: { kind: 'generation', failure } })
  })

  it('a failed upload releases the reserved bytes', async () => {
    h.s3Send.mockRejectedValue(new Error('S3 down'))
    expect(await generateDocumentImage(ctx(), REQUEST)).toEqual({ ok: false, failure: { kind: 'upload', message: 'S3 down' } })
    expect(h.deletePending).toHaveBeenCalledOnce()
  })

  it('without a write proof (or a document row) nothing is reserved, the image still uploads', async () => {
    const res = await generateDocumentImage(ctx({ docAccess: null }), REQUEST)
    expect(res.ok).toBe(true)
    expect(h.reservePendingUpload).not.toHaveBeenCalled()
    expect(h.markConfirmed).not.toHaveBeenCalled()
  })

  it('a failed reservation insert is not fatal', async () => {
    h.reservePendingUpload.mockRejectedValue(new Error('db down'))
    expect((await generateDocumentImage(ctx(), REQUEST)).ok).toBe(true)
    expect(h.markConfirmed).not.toHaveBeenCalled()
  })
})

describe('generate_image (the AI tool) keeps its messages', () => {
  const args = { prompt: 'a lighthouse', alt: 'Lighthouse' }

  it('success: the Markdown and the placement reminder', async () => {
    const res = await generateImageTool.run(ctx(), args)
    expect(res.isError).toBe(false)
    expect(res.content).toMatch(/^Generated and uploaded image\/png image \(0KB\)\. Markdown reference .*!\[Lighthouse\]\(\/api\/files\/doc12345\//)
  })

  it('failures read as before', async () => {
    h.sumImageBytesInScope.mockResolvedValue(5000)
    expect((await generateImageTool.run(ctx(), args)).content).toBe('Error: Image storage full (1000 bytes).')

    h.sumImageBytesInScope.mockResolvedValue(0)
    h.s3Send.mockRejectedValue(new Error('S3 down'))
    expect((await generateImageTool.run(ctx(), args)).content).toBe('Error: failed to upload generated image: S3 down')

    h.generateImageBytes.mockResolvedValue({ error: 'Image generation failed: boom' })
    expect((await generateImageTool.run(ctx(), args)).content).toBe('Error: Image generation failed: boom')

    h.generateImageBytes.mockResolvedValue({ error: 'Image generation failed: 503', providerUnavailable: true })
    const outage = await generateImageTool.run(ctx(), args)
    expect(outage.content).toBe('Error: Image generation failed: 503')
    expect(outage.endSessionWith).toBeTruthy()
  })
})
