import { brotliDecompressSync, inflateSync } from 'node:zlib'
import type { BrandFontFormat, FontRefusal } from '~~/shared/config/brandKit'
import { MIB } from '~~/shared/config/units'

// Inspects an uploaded font (brand kit) WITHOUT a font library:
// only the table directory and two small tables (`name`, `OS/2`) are
// read, every offset and length is bounds-checked, and decompression is
// size-capped. It decides two things:
//
//   1. Will the font print well? Chromium's PDF backend (Skia) embeds a
//      variable font (`fvar`) or one with CFF outlines (`OTTO`, `CFF `,
//      `CFF2`) as Type 3 glyph procedures — the reason the built-in
//      document fonts are static TrueType cuts (shared/utils/theme/themeFonts.ts).
//      Those are refused, as are collections (`ttcf`, several fonts in
//      one file) and fonts whose OS/2 `fsType` forbids embedding
//      (restricted licence: bit 1).
//   2. What is it? Family name (typographic family, else family), weight
//      class and italic flag — the defaults the upload form shows.
//
// What it does NOT do: validate glyph data. The browsers and the
// renderer's Chromium run every web font through OTS (the OpenType
// sanitizer) before using it; a damaged font just doesn't load there.

export type FontInspection
  = | { ok: true, format: BrandFontFormat, family: string, weight: number, italic: boolean }
    | { ok: false, reason: FontRefusal }

const SFNT_TRUETYPE = 0x00010000
const TAG_TRUE = 0x74727565 // 'true' (old Apple TrueType)
const TAG_OTTO = 0x4F54544F // 'OTTO' (CFF outlines)
const TAG_TTCF = 0x74746366 // 'ttcf' (collection)
const TAG_WOFF = 0x774F4646 // 'wOFF'
const TAG_WOF2 = 0x774F4632 // 'wOF2'

/** Upper bound for decompressed font data (a CJK font is ~20 MB). */
const MAX_DECOMPRESSED = 64 * MIB
const MAX_TABLES = 200
/**
 * Upper bound for the declared size of a table this module reads. Every
 * offset and length inside `name` is a uint16, so no byte past
 * ~6 + 12·2000 + 3·65535 ≈ 220 KB is ever addressed; OS/2 is ≤ 100 bytes
 * in every version. A larger declaration only serves to make the inflater
 * allocate, so it is refused.
 */
const MAX_READ_TABLE = MIB
/**
 * WOFF2: the whole Brotli stream has to be decompressed to reach `name`
 * (encoders sort it after `glyf`), so the declared total is bounded by
 * the stream it comes from as well as absolutely. Real fonts stay below
 * 6:1 (≈ 4.1 across the bundled Fontsource cuts, ≈ 5.8 across a few
 * thousand web and icon fonts); 16:1 leaves room for outliers while a
 * few hundred bytes of Brotli can no longer claim tens of megabytes.
 */
const MAX_WOFF2_RATIO = 16
/** Below this, the ratio is not checked (tiny fonts, tiny allocations). */
const WOFF2_RATIO_FLOOR = MIB

/** WOFF2 known-table tags, by index (WOFF2 spec §5.1). */
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
] as const

class Damaged extends Error {}

/** Bounds-checked big-endian reader over a byte array. */
class Reader {
  private readonly view: DataView
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get length(): number {
    return this.bytes.byteLength
  }

  private need(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.bytes.byteLength) throw new Damaged('out of bounds')
  }

  u8(offset: number): number {
    this.need(offset, 1)
    return this.view.getUint8(offset)
  }

  u16(offset: number): number {
    this.need(offset, 2)
    return this.view.getUint16(offset)
  }

  u32(offset: number): number {
    this.need(offset, 4)
    return this.view.getUint32(offset)
  }

  tag(offset: number): string {
    this.need(offset, 4)
    return String.fromCharCode(...this.bytes.subarray(offset, offset + 4))
  }

  slice(offset: number, length: number): Uint8Array {
    this.need(offset, length)
    return this.bytes.subarray(offset, offset + length)
  }
}

interface Tables {
  tags: Set<string>
  /** The raw (uncompressed, untransformed) bytes of `name` and `OS/2`, when present. */
  get(tag: 'name' | 'OS/2'): Uint8Array | null
}

export function inspectFont(bytes: Uint8Array): FontInspection {
  if (bytes.byteLength < 12) return { ok: false, reason: 'not-a-font' }
  const r = new Reader(bytes)
  try {
    const signature = r.u32(0)
    let format: BrandFontFormat
    let flavor: number
    let tables: Tables
    if (signature === TAG_WOF2) {
      format = 'woff2'
      flavor = r.u32(4)
      if (flavor === TAG_TTCF) return { ok: false, reason: 'collection' }
      tables = woff2Tables(r)
    } else if (signature === TAG_WOFF) {
      format = 'woff'
      flavor = r.u32(4)
      if (flavor === TAG_TTCF) return { ok: false, reason: 'collection' }
      tables = woffTables(r)
    } else if (signature === SFNT_TRUETYPE || signature === TAG_TRUE || signature === TAG_OTTO) {
      format = 'ttf'
      flavor = signature
      tables = sfntTables(r)
    } else if (signature === TAG_TTCF) {
      return { ok: false, reason: 'collection' }
    } else {
      return { ok: false, reason: 'not-a-font' }
    }

    if (tables.tags.has('fvar') || tables.tags.has('gvar')) return { ok: false, reason: 'variable' }
    if (flavor === TAG_OTTO || tables.tags.has('CFF ') || tables.tags.has('CFF2')) return { ok: false, reason: 'cff' }
    for (const required of ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'glyf', 'loca'] as const) {
      if (!tables.tags.has(required)) return { ok: false, reason: 'damaged' }
    }

    const os2 = tables.get('OS/2')
    let weight = 400
    let italic = false
    if (os2) {
      const o = new Reader(os2)
      const fsType = o.u16(8)
      // Bit 1: restricted licence embedding — the font must not be
      // embedded in documents at all. (Bits 2/3 = preview & print /
      // editable embedding are fine; bit 9 = bitmap only.)
      if ((fsType & 0x0002) !== 0 && (fsType & 0x000C) === 0) return { ok: false, reason: 'no-embedding' }
      if ((fsType & 0x0200) !== 0) return { ok: false, reason: 'no-embedding' }
      weight = clampWeight(o.u16(4))
      if (o.length >= 64) italic = (o.u16(62) & 0x0001) !== 0
    }
    const name = tables.get('name')
    const family = name ? familyName(new Reader(name)) : ''
    return { ok: true, format, family: sanitizeFamily(family), weight, italic }
  } catch (e) {
    if (e instanceof Damaged || e instanceof RangeError) return { ok: false, reason: 'damaged' }
    // zlib / brotli errors (corrupt or oversized streams)
    if (e instanceof Error && 'code' in e) return { ok: false, reason: 'damaged' }
    throw e
  }
}

function sfntTables(r: Reader): Tables {
  const numTables = r.u16(4)
  if (numTables === 0 || numTables > MAX_TABLES) throw new Damaged('table count')
  const entries = new Map<string, { offset: number, length: number }>()
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16
    const entry = { offset: r.u32(at + 8), length: r.u32(at + 12) }
    // Every table must lie inside the file, read or not.
    if (entry.offset + entry.length > r.length) throw new Damaged('table outside the file')
    entries.set(r.tag(at), entry)
  }
  return {
    tags: new Set(entries.keys()),
    get(tag) {
      const e = entries.get(tag)
      return e ? r.slice(e.offset, e.length) : null
    }
  }
}

function woffTables(r: Reader): Tables {
  const numTables = r.u16(12)
  if (numTables === 0 || numTables > MAX_TABLES) throw new Damaged('table count')
  const entries = new Map<string, { offset: number, compLength: number, origLength: number }>()
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20
    const entry = { offset: r.u32(at + 4), compLength: r.u32(at + 8), origLength: r.u32(at + 12) }
    if (entry.offset + entry.compLength > r.length) throw new Damaged('table outside the file')
    entries.set(r.tag(at), entry)
  }
  return {
    tags: new Set(entries.keys()),
    get(tag) {
      const e = entries.get(tag)
      if (!e) return null
      if (e.origLength > MAX_READ_TABLE) throw new Damaged('table size')
      const data = r.slice(e.offset, e.compLength)
      if (e.compLength === e.origLength) return data
      if (e.compLength > e.origLength) throw new Damaged('table size')
      const out = inflateSync(data, { maxOutputLength: e.origLength })
      if (out.byteLength !== e.origLength) throw new Damaged('table size')
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    }
  }
}

/** WOFF2 UIntBase128 (spec §6.1.1). */
function readBase128(r: Reader, at: number): { value: number, next: number } {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const b = r.u8(at + i)
    if (i === 0 && b === 0x80) throw new Damaged('base128 leading zero')
    if (value & 0xFE000000) throw new Damaged('base128 overflow')
    value = (value << 7) | (b & 0x7F)
    if ((b & 0x80) === 0) return { value: value >>> 0, next: at + i + 1 }
  }
  throw new Damaged('base128 too long')
}

function woff2Tables(r: Reader): Tables {
  const numTables = r.u16(12)
  if (numTables === 0 || numTables > MAX_TABLES) throw new Damaged('table count')
  const totalCompressed = r.u32(20)
  let at = 48
  const entries: Array<{ tag: string, length: number }> = []
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8(at)
    at += 1
    const tagIndex = flags & 0x3F
    let tag: string
    if (tagIndex === 63) {
      tag = r.tag(at)
      at += 4
    } else {
      const known = WOFF2_KNOWN_TAGS[tagIndex]
      if (!known) throw new Damaged('tag index')
      tag = known
    }
    const transformVersion = (flags >> 6) & 0x03
    const orig = readBase128(r, at)
    at = orig.next
    let length = orig.value
    // glyf / loca: version 0 = transformed (has transformLength), 3 = null.
    // Every other table: version 0 = null, anything else = transformed.
    const transformed = tag === 'glyf' || tag === 'loca' ? transformVersion === 0 : transformVersion !== 0
    if (transformed) {
      const t = readBase128(r, at)
      at = t.next
      length = t.value
    }
    entries.push({ tag, length })
  }
  const total = entries.reduce((n, e) => n + e.length, 0)
  if (total > MAX_DECOMPRESSED) throw new Damaged('decompressed size')
  if (totalCompressed === 0 || totalCompressed > r.length - at) throw new Damaged('compressed size')
  if (total > Math.max(WOFF2_RATIO_FLOOR, totalCompressed * MAX_WOFF2_RATIO)) throw new Damaged('compression ratio')
  for (const e of entries) {
    if ((e.tag === 'name' || e.tag === 'OS/2') && e.length > MAX_READ_TABLE) throw new Damaged('table size')
  }
  let decompressed: Uint8Array | null = null
  const stream = (): Uint8Array => {
    if (!decompressed) {
      const out = brotliDecompressSync(r.slice(at, totalCompressed), { maxOutputLength: total })
      decompressed = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    }
    return decompressed
  }
  const offsets = new Map<string, { offset: number, length: number }>()
  let offset = 0
  for (const e of entries) {
    offsets.set(e.tag, { offset, length: e.length })
    offset += e.length
  }
  return {
    tags: new Set(entries.map(e => e.tag)),
    get(tag) {
      const e = offsets.get(tag)
      if (!e) return null
      return new Reader(stream()).slice(e.offset, e.length)
    }
  }
}

/** Typographic family (name ID 16), else family (1); Windows Unicode English first. */
function familyName(n: Reader): string {
  const count = n.u16(2)
  const stringOffset = n.u16(4)
  if (count > 2000) throw new Damaged('name count')
  let best: { score: number, value: string } | null = null
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12
    const platformId = n.u16(at)
    const encodingId = n.u16(at + 2)
    const languageId = n.u16(at + 4)
    const nameId = n.u16(at + 6)
    const length = n.u16(at + 8)
    const offset = n.u16(at + 10)
    if (nameId !== 1 && nameId !== 16) continue
    let value: string
    let score = nameId === 16 ? 10 : 0
    if (platformId === 3 && (encodingId === 1 || encodingId === 10)) {
      const raw = n.slice(stringOffset + offset, length)
      value = ''
      for (let j = 0; j + 1 < raw.length; j += 2) value += String.fromCharCode((raw[j]! << 8) | raw[j + 1]!)
      score += languageId === 0x0409 ? 5 : 3
    } else if (platformId === 1 && encodingId === 0) {
      value = String.fromCharCode(...n.slice(stringOffset + offset, length))
      score += languageId === 0 ? 2 : 1
    } else if (platformId === 0) {
      const raw = n.slice(stringOffset + offset, length)
      value = ''
      for (let j = 0; j + 1 < raw.length; j += 2) value += String.fromCharCode((raw[j]! << 8) | raw[j + 1]!)
      score += 1
    } else {
      continue
    }
    if (!best || score > best.score) best = { score, value }
  }
  return best?.value ?? ''
}

/** Keep only what a theme font name may contain (letters, digits, spaces, ≤ 40). */
export function sanitizeFamily(raw: string): string {
  return raw.replace(/\p{S}/gu, ' ').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim()
}

function clampWeight(w: number): number {
  if (!Number.isFinite(w) || w < 1) return 400
  // Some fonts store 1–9 (old Apple convention) instead of 100–900.
  const v = w < 10 ? w * 100 : w
  return Math.min(900, Math.max(100, Math.round(v / 100) * 100))
}
