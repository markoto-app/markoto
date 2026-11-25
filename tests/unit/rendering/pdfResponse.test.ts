import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../../server/utils/storage/s3', () => ({ useS3Client: () => ({ send }) }))

const { openRenderedPdf, pdfContentDisposition } = await import('../../../server/utils/rendering/pdfResponse')

describe('pdfContentDisposition', () => {
  it('names the file after the title, attachment or inline', () => {
    expect(pdfContentDisposition('My Report 2026', false)).toBe('attachment; filename="My Report 2026.pdf"; filename*=UTF-8\'\'My%20Report%202026.pdf')
    expect(pdfContentDisposition('My Report', true)).toMatch(/^inline; filename="My Report\.pdf"/)
  })

  it('keeps header-breaking characters out and the full title in filename*', () => {
    const d = pdfContentDisposition('Bericht über "Zürich"/2026\\x\r\n', false)
    expect(d).toMatch(/^attachment; filename="Bericht ber Zrich2026x\.pdf"; filename\*=UTF-8''/)
    expect(d).not.toMatch(/[\r\n]/)
    expect(decodeURIComponent(d.split('UTF-8\'\'')[1] ?? '')).toBe('Bericht über Zürich2026x.pdf')
  })

  it('falls back to "document" for an empty or unusable title', () => {
    expect(pdfContentDisposition('', false)).toMatch(/filename="document\.pdf"/)
    expect(pdfContentDisposition(null, false)).toMatch(/filename="document\.pdf"/)
    expect(pdfContentDisposition('日本語', false)).toMatch(/filename="document\.pdf"; filename\*=UTF-8''%E6/)
  })
})

describe('openRenderedPdf', () => {
  beforeEach(() => {
    send.mockReset()
  })

  it('streams the object with its length', async () => {
    const stream = new ReadableStream()
    send.mockResolvedValue({ Body: { transformToWebStream: () => stream }, ContentLength: 1234 })
    await expect(openRenderedPdf('renders/doc/1/document.pdf')).resolves.toEqual({ stream, length: 1234 })
  })

  it('a missing object is a failed render', async () => {
    send.mockResolvedValue({ Body: undefined })
    await expect(openRenderedPdf('renders/x')).rejects.toMatchObject({ data: { code: 'docs/render-failed' } })
    send.mockRejectedValue(new Error('NoSuchKey'))
    await expect(openRenderedPdf('renders/x')).rejects.toMatchObject({ data: { code: 'docs/render-failed' } })
  })
})
