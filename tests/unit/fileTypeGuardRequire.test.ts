import { describe, it, expect, vi, beforeEach } from 'vitest'

// requireContentMatchesExtension is the server-side guard that stops a
// presign-for-pdf + PUT-of-exe attack. It fetches the first 4 KiB from
// S3 via Range GET, then either sniffs magic bytes (binary formats) or
// does a printable-UTF-8 ratio check (text formats).
//
// These tests stub the S3 client to feed deterministic byte buffers at
// the guard, covering every ext branch and the failure modes of each.
//
// The complementary `fileTypeGuard.test.ts` locks in the `file-type`
// library's behaviour on sample headers; here we focus on the guard's
// branching and throw contracts.

const mockBytes = vi.fn<() => Promise<Uint8Array>>()

const fakeS3 = {
  send: vi.fn(async (_cmd: unknown) => ({
    Body: {
      transformToByteArray: async () => mockBytes()
    }
  }))
}

vi.stubGlobal('useS3Client', () => fakeS3)
vi.stubGlobal('useRuntimeConfig', () => ({ s3: { bucket: 'test-bucket' } }))
vi.stubGlobal('createError', (opts: { statusCode: number, message: string }) => {
  const err = new Error(opts.message) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
})

const { requireContentMatchesExtension } = await import('../../server/utils/fileTypeGuard')

beforeEach(() => {
  mockBytes.mockReset()
  fakeS3.send.mockClear()
})

// ─── Fixtures ─────────────────────────────────────────────────────────────

function pdfBytes(): Uint8Array {
  // Minimal PDF header — file-type recognises this unambiguously.
  return new TextEncoder().encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
}

function unknownBinary(): Uint8Array {
  // 32 bytes that don't match ANY file-type signature.
  return new Uint8Array(32).map((_, i) => (i * 13 + 7) & 0xff)
}

function bareZip(): Uint8Array {
  // ZIP local-file header — file-type returns application/zip, which is
  // not in our Office allowlist (DOCX/PPTX/XLSX require the specific
  // MIME from [Content_Types].xml inspection).
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
}

function plainText(): Uint8Array {
  return new TextEncoder().encode('Hello, world. This is plausibly text.')
}

function binaryInTextClothing(): Uint8Array {
  // 80% non-printable → below the 0.9 threshold even after UTF-8 decodes.
  // Use low control bytes that DO decode as valid UTF-8 but aren't printable.
  const bytes = new Uint8Array(100)
  // First 10 bytes are printable ASCII, last 90 are control bytes in the
  // 0x01-0x08 range (valid UTF-8, not printable).
  for (let i = 0; i < 10; i++) bytes[i] = 0x41 // 'A'
  for (let i = 10; i < 100; i++) bytes[i] = (i % 8) + 1
  return bytes
}

function invalidUtf8(): Uint8Array {
  // 0xFF 0xFE in a position where UTF-8 requires a continuation byte.
  // TextDecoder with { fatal: true } throws → isPrintableUtf8 returns false.
  return new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('requireContentMatchesExtension — binary formats', () => {
  it('accepts a real PDF for .pdf', async () => {
    mockBytes.mockResolvedValueOnce(pdfBytes())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'pdf' })).resolves.toBeUndefined()
  })

  it('rejects a PDF signed as .docx (415, mime mismatch)', async () => {
    // The attacker scenario: signed as .docx, actual bytes are a PDF.
    mockBytes.mockResolvedValueOnce(pdfBytes())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'docx' }))
      .rejects.toMatchObject({ statusCode: 415, message: expect.stringContaining('application/pdf') })
  })

  it('rejects a bare ZIP for .docx (not enough to be a valid Office file)', async () => {
    // A plain PK-ZIP with no [Content_Types].xml is detected as
    // application/zip by file-type, which our allowlist rejects. This
    // pins the behaviour — an attacker can't sneak through with a
    // truncated ZIP header.
    mockBytes.mockResolvedValueOnce(bareZip())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'docx' }))
      .rejects.toMatchObject({ statusCode: 415 })
  })

  it('rejects unknown bytes (file-type returns undefined)', async () => {
    mockBytes.mockResolvedValueOnce(unknownBinary())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'pdf' }))
      .rejects.toMatchObject({
        statusCode: 415,
        message: expect.stringContaining('Could not determine content type')
      })
  })

  it('rejects a totally unsupported extension with 415', async () => {
    // An ext that's not in TEXT_EXTS and not in EXT_TO_ALLOWED_MIMES.
    // Should fail before we even fetch S3 bytes — the ext lookup is
    // cheap and filters obvious junk early.
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'exe' }))
      .rejects.toMatchObject({ statusCode: 415, message: expect.stringContaining('Unsupported extension') })
    // Should NOT have hit S3 for this branch — unsupported-ext is a
    // cheap early-return, no byte fetch.
    expect(fakeS3.send).not.toHaveBeenCalled()
  })

  it('normalises ext casing before dispatch (PDF == pdf)', async () => {
    mockBytes.mockResolvedValueOnce(pdfBytes())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'PDF' })).resolves.toBeUndefined()
  })

  it('surfaces an S3 fetch failure as 500 (fails closed, not silent accept)', async () => {
    fakeS3.send.mockRejectedValueOnce(new Error('S3 boom'))
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'pdf' }))
      .rejects.toMatchObject({
        statusCode: 500,
        message: expect.stringContaining('S3 boom')
      })
  })
})

describe('requireContentMatchesExtension — text formats', () => {
  it('accepts plausibly-printable text for .md', async () => {
    mockBytes.mockResolvedValueOnce(plainText())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'md' })).resolves.toBeUndefined()
  })

  it('accepts plausibly-printable text for .txt', async () => {
    mockBytes.mockResolvedValueOnce(plainText())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'txt' })).resolves.toBeUndefined()
  })

  it('accepts plausibly-printable text for .html', async () => {
    mockBytes.mockResolvedValueOnce(new TextEncoder().encode('<html><body>hi</body></html>'))
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'html' })).resolves.toBeUndefined()
  })

  it('accepts plausibly-printable text for .htm (alias)', async () => {
    mockBytes.mockResolvedValueOnce(plainText())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'htm' })).resolves.toBeUndefined()
  })

  it('rejects low-printable-ratio bytes for .txt', async () => {
    mockBytes.mockResolvedValueOnce(binaryInTextClothing())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'txt' }))
      .rejects.toMatchObject({
        statusCode: 415,
        message: expect.stringContaining(`doesn't look like text`)
      })
  })

  it('rejects invalid UTF-8 for .md (TextDecoder fatal path)', async () => {
    mockBytes.mockResolvedValueOnce(invalidUtf8())
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'md' }))
      .rejects.toMatchObject({ statusCode: 415 })
  })

  it('rejects an empty text file (no bytes to verify)', async () => {
    mockBytes.mockResolvedValueOnce(new Uint8Array(0))
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'txt' }))
      .rejects.toMatchObject({ statusCode: 415 })
  })

  it('surfaces an S3 fetch failure as 500 for text paths too', async () => {
    fakeS3.send.mockRejectedValueOnce(new Error('S3 down'))
    await expect(requireContentMatchesExtension({ s3Key: 'k', ext: 'md' }))
      .rejects.toMatchObject({ statusCode: 500 })
  })
})
