import { readFileSync } from 'node:fs'
import { brotliCompressSync, deflateSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectFont, sanitizeFamily } from '../../../server/utils/brandKit/fontInspect'

// The brand-kit font inspectoron real font files: the static
// Fontsource cuts the app ships (WOFF2 + WOFF), a TrueType file built from
// one of them here, the variable cuts, and byte-patched variants for the
// refusals (CFF outlines, collection, restricted embedding, damage).

const read = (p: string): Uint8Array => new Uint8Array(readFileSync(p))
const INTER_WOFF2 = read('node_modules/@fontsource/inter/files/inter-latin-700-italic.woff2')
const INTER_WOFF = read('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff')
const INTER_VARIABLE = read('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')

/** WOFF → plain sfnt (TrueType), inflate every table, write the table directory. */
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

const REQUIRED_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'glyf', 'loca']

/** A minimal WOFF whose `name` table is `nameData` claiming `nameOrigLength` bytes once inflated. */
function craftWoff(nameData: Uint8Array, nameOrigLength: number): Uint8Array {
  const tags = [...REQUIRED_TAGS, 'name']
  const dirEnd = 44 + tags.length * 20
  const out = new Uint8Array(dirEnd + REQUIRED_TAGS.length * 4 + nameData.byteLength)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x774F4646)
  v.setUint32(4, 0x00010000)
  v.setUint32(8, out.byteLength)
  v.setUint16(12, tags.length)
  let dataAt = dirEnd
  tags.forEach((tag, i) => {
    const at = 44 + i * 20
    out.set([...tag].map(c => c.charCodeAt(0)), at)
    const data = tag === 'name' ? nameData : new Uint8Array(4)
    v.setUint32(at + 4, dataAt)
    v.setUint32(at + 8, data.byteLength)
    v.setUint32(at + 12, tag === 'name' ? nameOrigLength : 4)
    out.set(data, dataAt)
    dataAt += data.byteLength
  })
  return out
}

function base128(n: number): number[] {
  const bytes = [n & 0x7F]
  for (let rest = Math.floor(n / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7F) | 0x80)
  return bytes
}

/** WOFF2 known-table indices (spec §5.1) for the tables the crafted fonts carry. */
const WOFF2_INDEX: Record<string, number> = { cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, glyf: 10, loca: 11 }

/** A minimal WOFF2: the given (untransformed) table lengths, followed by `stream` as the Brotli data. */
function craftWoff2(lengths: Record<string, number>, stream: Uint8Array): Uint8Array {
  const dir: number[] = []
  for (const [tag, length] of Object.entries(lengths)) {
    // glyf / loca: transform version 3 = untransformed; others: version 0.
    const version = tag === 'glyf' || tag === 'loca' ? 3 : 0
    dir.push((version << 6) | WOFF2_INDEX[tag]!, ...base128(length))
  }
  const out = new Uint8Array(48 + dir.length + stream.byteLength)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x774F4632)
  v.setUint32(4, 0x00010000)
  v.setUint32(8, out.byteLength)
  v.setUint16(12, Object.keys(lengths).length)
  v.setUint32(20, stream.byteLength)
  out.set(dir, 48)
  out.set(stream, 48 + dir.length)
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

  it('refuses a WOFF whose name table claims more than a name table can address', () => {
    // 32 MB of zeros deflate to ~32 KB: the inflater must never be asked for them.
    const bomb = new Uint8Array(deflateSync(new Uint8Array(32 * 1024 * 1024)))
    expect(inspectFont(craftWoff(bomb, 32 * 1024 * 1024))).toEqual({ ok: false, reason: 'damaged' })
    // Declares a small table but inflates to far more: the output cap holds.
    expect(inspectFont(craftWoff(bomb, 1000))).toEqual({ ok: false, reason: 'damaged' })
  })

  it('refuses a WOFF2 that claims far more data than its Brotli stream can honestly hold', () => {
    const tables = { cmap: 4, head: 4, hhea: 4, hmtx: 4, maxp: 4, glyf: 48 * 1024 * 1024, loca: 4, name: 64 }
    const total = Object.values(tables).reduce((a, b) => a + b, 0)
    // A few hundred bytes of Brotli that really do expand to the declared 48 MB.
    const bomb = new Uint8Array(brotliCompressSync(new Uint8Array(total)))
    expect(bomb.byteLength).toBeLessThan(4096)
    expect(inspectFont(craftWoff2(tables, bomb))).toEqual({ ok: false, reason: 'damaged' })
  })

  it('refuses a WOFF2 whose stream inflates past the declared table sizes', () => {
    const tables = { cmap: 4, head: 4, hhea: 4, hmtx: 4, maxp: 4, glyf: 4, loca: 4, name: 64 }
    const bomb = new Uint8Array(brotliCompressSync(new Uint8Array(8 * 1024 * 1024)))
    expect(inspectFont(craftWoff2(tables, bomb))).toEqual({ ok: false, reason: 'damaged' })
  })

  it('refuses a WOFF2 name table larger than a name table can address', () => {
    const tables = { cmap: 4, head: 4, hhea: 4, hmtx: 4, maxp: 4, glyf: 4, loca: 4, name: 2 * 1024 * 1024 }
    // Enough stream bytes to pass the ratio check, so the per-table cap is what refuses.
    expect(inspectFont(craftWoff2(tables, new Uint8Array(256 * 1024)))).toEqual({ ok: false, reason: 'damaged' })
  })

  it('keeps family names to what a theme font name may contain', () => {
    expect(sanitizeFamily('Acme Sans™ Pro')).toBe('Acme Sans Pro')
    expect(sanitizeFamily('Söhne')).toBe('Sohne')
    expect(sanitizeFamily('\'); } body { x')).toBe('body x')
    expect(sanitizeFamily('a'.repeat(60))).toHaveLength(40)
  })
})
