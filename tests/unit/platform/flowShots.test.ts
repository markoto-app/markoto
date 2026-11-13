import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp, { type WebpOptions } from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { framesDiffer, manifestKey, syncVariant } from '../../../scripts/lib/flowShots'

// The docs screenshots are republished after every release. A frame that
// looks the same must keep its committed bytes (no git churn), a frame
// that shows something else must be replaced. Synthetic frames, so the
// cases don't depend on the fonts of the machine running the test.

const W = 320
const H = 200
const CREAM = [244, 241, 234, 255] as const
const INK = [119, 119, 119, 255] as const // mid-grey text, the faintest the threshold is meant to catch

/** A UI-like frame: cream background with rows of grey "text" strokes. */
function baseFrame(): Buffer {
  const px = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) px.set(CREAM, i * 4)
  for (let row = 20; row < H - 20; row += 24) {
    for (let x = 16; x < W - 16; x++) {
      // 1-px strokes in a glyph-like rhythm
      if (x % 7 === 0 || x % 11 === 0) for (let y = row; y < row + 10; y++) px.set(INK, (y * W + x) * 4)
    }
  }
  return px
}

function setPixel(px: Buffer, x: number, y: number, rgba: readonly number[]): void {
  px.set(rgba, (y * W + x) * 4)
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flowshots-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function webp(name: string, px: Buffer, options: WebpOptions = { lossless: true }, width = W, height = H): Promise<string> {
  const file = path.join(dir, name)
  await sharp(px, { raw: { width, height, channels: 4 } }).webp(options).toFile(file)
  return file
}

describe('framesDiffer', () => {
  it('keeps an identical picture encoded to different bytes', async () => {
    const a = await webp('a.webp', baseFrame(), { lossless: true, effort: 0 })
    const b = await webp('b.webp', baseFrame(), { lossless: true, effort: 6 })
    expect(await readFile(a)).not.toEqual(await readFile(b))
    expect(await framesDiffer(a, b)).toBe(false)
  })

  it('keeps anti-aliasing noise: small shifts everywhere, a few strong pixels scattered', async () => {
    const noisy = baseFrame()
    for (let i = 0; i < W * H; i += 3) noisy[i * 4] = Math.min(255, (noisy[i * 4] ?? 0) + 20)
    for (let k = 0; k < 15; k++) setPixel(noisy, (k * 37) % W, (k * 53) % H, [0, 0, 0, 255])
    expect(await framesDiffer(await webp('a.webp', baseFrame()), await webp('b.webp', noisy))).toBe(false)
  })

  it('replaces a frame where one glyph-sized spot changed', async () => {
    const changed = baseFrame()
    // a 7×10 letter in mid-grey ink where there was background
    for (let y = 44; y < 54; y++) for (let x = 100; x < 107; x++) if ((x + y) % 2 === 0) setPixel(changed, x, y, INK)
    expect(await framesDiffer(await webp('a.webp', baseFrame()), await webp('b.webp', changed))).toBe(true)
  })

  it('replaces a resized frame', async () => {
    const small = Buffer.alloc((W - 10) * H * 4, 0xF4)
    expect(await framesDiffer(await webp('a.webp', baseFrame()), await webp('b.webp', small, { lossless: true }, W - 10, H))).toBe(true)
  })

  it('replaces a frame whose transparency changed', async () => {
    const faded = baseFrame()
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) faded[(y * W + x) * 4 + 3] = 128
    expect(await framesDiffer(await webp('a.webp', baseFrame()), await webp('b.webp', faded))).toBe(true)
  })
})

describe('manifestKey', () => {
  it('ignores the random document / workspace ids of a run, nothing else', () => {
    expect(manifestKey('"path": "/d/NJlsbbkxNH"')).toBe(manifestKey('"path": "/d/Xy7_kd02Ab"'))
    expect(manifestKey('"path": "/w/abcdefgh12"')).toBe(manifestKey('"path": "/w/zyxwvuts98"'))
    expect(manifestKey('"caption": "Save"')).not.toBe(manifestKey('"caption": "Saved"'))
    expect(manifestKey('"path": "/d/NJlsbbkxNH"')).not.toBe(manifestKey('"path": "/w/NJlsbbkxNH"'))
  })
})

describe('syncVariant', () => {
  it('keeps unchanged frames byte-for-byte, replaces changed ones, adds new ones, removes gone ones', async () => {
    const src = path.join(dir, 'src')
    const dst = path.join(dir, 'dst')
    const changed = baseFrame()
    for (let y = 44; y < 54; y++) for (let x = 100; x < 120; x++) setPixel(changed, x, y, [0, 0, 0, 255])
    await mkdir(src)
    await mkdir(dst)
    // committed: 01 (same picture, other bytes), 02 (old picture), 03 (gone from the new run)
    await sharp(baseFrame(), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(path.join(dst, '01.webp'))
    await sharp(baseFrame(), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toFile(path.join(dst, '02.webp'))
    await sharp(baseFrame(), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toFile(path.join(dst, '03.webp'))
    await writeFile(path.join(dst, 'manifest.json'), '{"path": "/d/OLDOLDOLD1", "file": "01.webp"}\n')
    // new run: 01 same picture, 02 changed, 04 new; manifest differs only in the doc id
    await sharp(baseFrame(), { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true, effort: 0 }).toFile(path.join(src, '01.webp'))
    await sharp(changed, { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toFile(path.join(src, '02.webp'))
    await sharp(changed, { raw: { width: W, height: H, channels: 4 } }).webp({ lossless: true }).toFile(path.join(src, '04.webp'))
    await writeFile(path.join(src, 'manifest.json'), '{"path": "/d/NEWNEWNEW2", "file": "01.webp"}\n')
    const committed01 = await readFile(path.join(dst, '01.webp'))

    const stats = await syncVariant(src, dst)

    expect(stats).toEqual({ kept: 1, replaced: 1, added: 1, removed: 1, manifestsWritten: 0 })
    expect(await readFile(path.join(dst, '01.webp'))).toEqual(committed01)
    expect(await readFile(path.join(dst, '02.webp'))).toEqual(await readFile(path.join(src, '02.webp')))
    expect((await readdir(dst)).sort()).toEqual(['01.webp', '02.webp', '04.webp', 'manifest.json'])
    expect(await readFile(path.join(dst, 'manifest.json'), 'utf8')).toContain('OLDOLDOLD1')

    // A manifest whose content changed is written.
    await writeFile(path.join(src, 'manifest.json'), '{"path": "/d/NEWNEWNEW2", "file": "02.webp"}\n')
    expect((await syncVariant(src, dst)).manifestsWritten).toBe(1)
    expect(await readFile(path.join(dst, 'manifest.json'), 'utf8')).toContain('"file": "02.webp"')
  })
})
