import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectFont, sanitizeFamily } from '../../server/utils/brandKit/fontInspect'

// The brand-kit font inspector (WP10) on real font files: the static
// Fontsource cuts the app ships (WOFF2 + WOFF), a TrueType file built from
// one of them here, the variable cuts, and byte-patched variants for the
// refusals (CFF outlines, collection, restricted embedding, damage).

const read = (p: string): Uint8Array => new Uint8Array(readFileSync(p))
const INTER_WOFF2 = read('node_modules/@fontsource/inter/files/inter-latin-700-italic.woff2')
const INTER_WOFF = read('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff')
const INTER_VARIABLE = read('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')

/** WOFF → plain sfnt (TrueType) — inflate every table, write the table directory. */
function woffToTtf(woff: Uint8Array): Uint8Array {
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength)
  const flavor = v.getUint32(4)
  const numTables = v.getUint16(12)
  const tables: Array<{ tag: number, checksum: number, data: Uint8Array }> = []
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20
    const offset = v.getUint32(at + 4)
    const comp = v.getUint32(at + 8)
    const orig = v.getUint32(at + 12)
    const raw = woff.subarray(offset, offset + comp)
    tables.push({ tag: v.getUint32(at), checksum: v.getUint32(at + 16), data: comp === orig ? raw : new Uint8Array(inflateSync(raw)) })
  }
  const pad = (n: number) => (n + 3) & ~3
  let size = 12 + numTables * 16
  for (const t of tables) size += pad(t.data.byteLength)
  const out = new Uint8Array(size)
  const o = new DataView(out.buffer)
  o.setUint32(0, flavor)
  o.setUint16(4, numTables)
  let dataAt = 12 + numTables * 16
  tables.forEach((t, i) => {
    const at = 12 + i * 16
    o.setUint32(at, t.tag)
    o.setUint32(at + 4, t.checksum)
    o.setUint32(at + 8, dataAt)
    o.setUint32(at + 12, t.data.byteLength)
    out.set(t.data, dataAt)
    dataAt += pad(t.data.byteLength)
  })
  return out
}

/** Offset of a table in a plain sfnt. */
function tableOffset(ttf: Uint8Array, tag: string): number {
  const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength)
  for (let i = 0; i < v.getUint16(4); i++) {
    const at = 12 + i * 16
    if (String.fromCharCode(...ttf.subarray(at, at + 4)) === tag) return v.getUint32(at + 8)
  }
  throw new Error(`no ${tag}`)
}

function renameTable(ttf: Uint8Array, from: string, to: string): Uint8Array {
  const out = ttf.slice()
  const v = new DataView(out.buffer)
  for (let i = 0; i < v.getUint16(4); i++) {
    const at = 12 + i * 16
    if (String.fromCharCode(...out.subarray(at, at + 4)) === from) out.set([...to].map(c => c.charCodeAt(0)), at)
  }
  return out
}

describe('inspectFont', () => {
  it('reads family, weight and style of a static WOFF2 cut', () => {
    expect(inspectFont(INTER_WOFF2)).toEqual({ ok: true, format: 'woff2', family: 'Inter', weight: 700, italic: true })
  })

  it('reads a WOFF cut', () => {
    expect(inspectFont(INTER_WOFF)).toEqual({ ok: true, format: 'woff', family: 'Inter', weight: 400, italic: false })
  })

  it('reads a TrueType file', () => {
    expect(inspectFont(woffToTtf(INTER_WOFF))).toEqual({ ok: true, format: 'ttf', family: 'Inter', weight: 400, italic: false })
  })

  it('reads the bundled TeX Gyre and Latin Modern cuts', () => {
    for (const file of ['fonts/tex-gyre-termes/texgyretermes-regular.woff2', 'fonts/latin-modern-roman/lmroman10-bold.woff2']) {
      let bytes: Uint8Array
      try {
        bytes = read(file)
      } catch {
        continue
      }
      const r = inspectFont(bytes)
      expect(r.ok, file).toBe(true)
    }
  })

  it('refuses variable fonts', () => {
    expect(inspectFont(INTER_VARIABLE)).toEqual({ ok: false, reason: 'variable' })
  })

  it('refuses CFF outlines', () => {
    const ttf = woffToTtf(INTER_WOFF)
    const otto = ttf.slice()
    otto.set([0x4F, 0x54, 0x54, 0x4F], 0)
    expect(inspectFont(otto)).toEqual({ ok: false, reason: 'cff' })
    expect(inspectFont(renameTable(ttf, 'post', 'CFF '))).toEqual({ ok: false, reason: 'cff' })
  })

  it('refuses collections', () => {
    const ttc = new Uint8Array(64)
    ttc.set([0x74, 0x74, 0x63, 0x66], 0)
    expect(inspectFont(ttc)).toEqual({ ok: false, reason: 'collection' })
  })

  it('refuses fonts that forbid embedding, accepts print-and-preview embedding', () => {
    const ttf = woffToTtf(INTER_WOFF)
    const os2 = tableOffset(ttf, 'OS/2')
    const restricted = ttf.slice()
    new DataView(restricted.buffer).setUint16(os2 + 8, 0x0002)
    expect(inspectFont(restricted)).toEqual({ ok: false, reason: 'no-embedding' })
    const bitmapOnly = ttf.slice()
    new DataView(bitmapOnly.buffer).setUint16(os2 + 8, 0x0200)
    expect(inspectFont(bitmapOnly)).toEqual({ ok: false, reason: 'no-embedding' })
    const previewPrint = ttf.slice()
    new DataView(previewPrint.buffer).setUint16(os2 + 8, 0x0004)
    expect(inspectFont(previewPrint).ok).toBe(true)
  })

  it('refuses anything that is not a font, and damaged files, without throwing', () => {
    expect(inspectFont(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({ ok: false, reason: 'not-a-font' })
    expect(inspectFont(new Uint8Array(4))).toEqual({ ok: false, reason: 'not-a-font' })
    // Truncated in the middle of the table data.
    expect(inspectFont(INTER_WOFF2.subarray(0, 200))).toEqual({ ok: false, reason: 'damaged' })
    expect(inspectFont(woffToTtf(INTER_WOFF).subarray(0, 300))).toEqual({ ok: false, reason: 'damaged' })
    // A table directory pointing far outside the file.
    const ttf = woffToTtf(INTER_WOFF)
    new DataView(ttf.buffer).setUint32(12 + 8, 0x7FFFFFF0)
    expect(inspectFont(ttf)).toEqual({ ok: false, reason: 'damaged' })
    // Random bytes behind a valid signature.
    const junk = new Uint8Array(4096).map((_, i) => (i * 7919) & 0xFF)
    junk.set([0x77, 0x4F, 0x46, 0x32], 0)
    expect(inspectFont(junk).ok).toBe(false)
  })

  it('keeps family names to what a theme font name may contain', () => {
    expect(sanitizeFamily('Acme Sans™ Pro')).toBe('Acme Sans Pro')
    expect(sanitizeFamily('Söhne')).toBe('Sohne')
    expect(sanitizeFamily('\'); } body { x')).toBe('body x')
    expect(sanitizeFamily('a'.repeat(60))).toHaveLength(40)
  })
})
