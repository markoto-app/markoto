import { describe, expect, it } from 'vitest'
import { renderManifestSchema, renderResponseSchema } from '../../../shared/contracts/renderSchemas'

// The app ↔ renderer wire contract: the schemas the app parses answers with.

describe('render contract', () => {
  it('parses a render answer and refuses one without page keys', () => {
    expect(renderResponseSchema.parse({ pageCount: 2, pdfKey: 'renders/d/1/doc.pdf', pageKeys: [] })).toEqual({ pageCount: 2, pdfKey: 'renders/d/1/doc.pdf', pageKeys: [] })
    expect(renderResponseSchema.safeParse({ pageCount: 2 }).success).toBe(false)
  })

  it('parses a stored manifest and refuses an unknown format', () => {
    const manifest = { snapshotId: 4, pageCount: 1, format: 'pdf', renderedAt: '2026-01-01T00:00:00.000Z', pdfKey: 'k', pageKeys: [] }
    expect(renderManifestSchema.parse(manifest)).toEqual(manifest)
    expect(renderManifestSchema.safeParse({ ...manifest, format: 'html' }).success).toBe(false)
  })
})
