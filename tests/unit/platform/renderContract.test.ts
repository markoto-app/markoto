import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderManifestSchema, renderResponseSchema } from '../../../shared/contracts/renderSchemas'

// The app ↔ renderer wire contract. The renderer image is built from
// renderer/ alone, so it carries a copy of the shared types.

describe('render contract', () => {
  it('the renderer copy is byte-identical to the shared contract', () => {
    const root = resolve(__dirname, '../../..')
    const shared = readFileSync(resolve(root, 'shared/contracts/render.ts'), 'utf8')
    const copy = readFileSync(resolve(root, 'renderer/src/contract.ts'), 'utf8')
    expect(copy).toBe(shared)
  })

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
