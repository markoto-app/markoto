import { describe, it, expect } from 'vitest'
import { fileTypeFromBuffer } from 'file-type'

// These tests lock in the assumption our fileTypeGuard relies on: the
// `file-type` library correctly identifies the formats we accept. If
// the library's shipping detection logic changes or a format's magic
// bytes evolve, these break first, before a real upload hits 415.
//
// The guard itself (fileTypeGuard.ts) has an S3 dependency that's
// tested via the integration suite; these are pure-JS fixtures.

function pdfBytes(): Uint8Array {
  // Minimal PDF header: '%PDF-1.4\n'. file-type only inspects the
  // leading bytes; a full document isn't needed for detection.
  return new TextEncoder().encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
}

function zipBytes(): Uint8Array {
  // ZIP local-file header magic bytes: 50 4B 03 04
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
}

describe('file-type: magic-byte detection sanity', () => {
  it('detects PDF from its header', async () => {
    const result = await fileTypeFromBuffer(pdfBytes())
    expect(result?.mime).toBe('application/pdf')
  })

  it('detects a bare ZIP as application/zip (not a specific Office format)', async () => {
    // A plain ZIP with no [Content_Types].xml returns application/zip.
    // Our allowlist does NOT include application/zip, this would be
    // rejected as "expected DOCX, got zip". Locks in that behaviour.
    const result = await fileTypeFromBuffer(zipBytes())
    expect(result?.mime).toBe('application/zip')
  })

  it('returns undefined for a plain-text buffer (no magic bytes)', async () => {
    const text = new TextEncoder().encode('Hello, world. This is plain text.')
    const result = await fileTypeFromBuffer(text)
    // Plain text has no reliable signature, the library returns
    // undefined and we'd route this through the printable-ratio path.
    expect(result).toBeUndefined()
  })

  it('returns undefined for random junk bytes', async () => {
    const junk = new Uint8Array(32).map((_, i) => (i * 13 + 7) & 0xff)
    const result = await fileTypeFromBuffer(junk)
    expect(result).toBeUndefined()
  })
})
