// Publishing flow screenshots without churn (scripts/build-flows.ts).
//
// Every release re-records the whole flow suite. The browser never paints
// two runs byte-for-byte alike (text anti-aliasing, a pulsing recording
// dot, a shimmering "Thinking…"), and a lossless WebP of a frame that
// looks the same still gets new bytes, so republishing everything grew
// git history by tens of MB per release. Here a new frame replaces the
// committed one only when it looks different; otherwise the committed file
// stays byte-for-byte.

import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

/**
 * When two frames count as the same picture. Both are decoded to RGBA; a
 * pixel differs when any channel (alpha included) moves by more than
 * `channelDelta`; the frames differ when some `tile`×`tile` square holds
 * at least `pixelsPerTile` differing pixels, or the sizes differ. The
 * squares are counted on four grids shifted by half a tile, so a glyph
 * that straddles a tile border still lands whole in one square.
 *
 * Measured on two releases' screenshots (300 pairs) of the same screens:
 * text anti-aliasing stays below the channel delta, and animations (the
 * recording pulse, the "Thinking…" shimmer) put at most 18 differing
 * pixels into one square. Real changes put 26 (an avatar's changed eyes)
 * to 200+ into one: a changed word or digit, a moved progress bar, an
 * icon, faded text appearing. Below the threshold: a single added period,
 * a one-pixel nudge. tests/unit/platform/flowShots.test.ts pins the cases.
 */
const FRAME_TOLERANCE = { channelDelta: 24, tile: 16, pixelsPerTile: 24 } as const

type Raw = { data: Buffer, width: number, height: number }

async function decode(file: string): Promise<Raw> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Whether two images differ visibly (see FRAME_TOLERANCE). */
export async function framesDiffer(fileA: string, fileB: string, tolerance = FRAME_TOLERANCE): Promise<boolean> {
  const [a, b] = await Promise.all([decode(fileA), decode(fileB)])
  if (a.width !== b.width || a.height !== b.height) return true
  const half = Math.floor(tolerance.tile / 2)
  const grids = [[0, 0], [half, 0], [0, half], [half, half]] as const
  const tilesPerRow = Math.ceil((a.width + half) / tolerance.tile)
  const counts = grids.map(() => new Map<number, number>())
  for (let pixel = 0; pixel < a.width * a.height; pixel++) {
    if (pixelDelta(a.data, b.data, pixel * 4) <= tolerance.channelDelta) continue
    const x = pixel % a.width
    const y = Math.floor(pixel / a.width)
    for (const [g, [dx, dy]] of grids.entries()) {
      const tile = Math.floor((y + dy) / tolerance.tile) * tilesPerRow + Math.floor((x + dx) / tolerance.tile)
      const count = (counts[g]?.get(tile) ?? 0) + 1
      if (count >= tolerance.pixelsPerTile) return true
      counts[g]?.set(tile, count)
    }
  }
  return false
}

/** Largest channel difference (RGBA) of the pixel at `offset`. */
function pixelDelta(a: Buffer, b: Buffer, offset: number): number {
  let delta = 0
  for (let channel = 0; channel < 4; channel++) {
    delta = Math.max(delta, Math.abs((a[offset + channel] ?? 0) - (b[offset + channel] ?? 0)))
  }
  return delta
}

/**
 * Document / workspace / page ids in a manifest's address-bar paths are
 * random per run (`/d/NJlsbbkxNH`). A manifest that differs from the
 * committed one only in those keeps the committed file.
 */
export function manifestKey(text: string): string {
  return text.replace(/\/(d|w|p)\/[A-Za-z0-9_-]{6,}/g, '/$1/<id>')
}

export interface SyncStats {
  kept: number
  replaced: number
  added: number
  removed: number
  /** Manifests written because their content changed (or are new). */
  manifestsWritten: number
}

export const emptyStats = (): SyncStats => ({ kept: 0, replaced: 0, added: 0, removed: 0, manifestsWritten: 0 })

export function addStats(into: SyncStats, from: SyncStats): void {
  into.kept += from.kept
  into.replaced += from.replaced
  into.added += from.added
  into.removed += from.removed
  into.manifestsWritten += from.manifestsWritten
}

const isFrame = (name: string): boolean => name.endsWith('.webp')

async function listFiles(dir: string): Promise<string[]> {
  return fs.readdir(dir, { withFileTypes: true }).then(
    entries => entries.filter(e => e.isFile()).map(e => e.name),
    () => []
  )
}

/**
 * Make `dstDir` show what `srcDir` shows: frames that look the same keep
 * the committed file, changed ones are replaced, new ones added, frames
 * the new run no longer has removed; the manifest is rewritten only when
 * it changed beyond its random ids.
 */
export async function syncVariant(srcDir: string, dstDir: string, tolerance = FRAME_TOLERANCE): Promise<SyncStats> {
  const stats = emptyStats()
  await fs.mkdir(dstDir, { recursive: true })
  const srcFrames = (await listFiles(srcDir)).filter(isFrame)
  const dstFiles = await listFiles(dstDir)

  for (const name of srcFrames) {
    const src = path.join(srcDir, name)
    const dst = path.join(dstDir, name)
    if (!dstFiles.includes(name)) {
      await fs.copyFile(src, dst)
      stats.added++
    } else if (await framesDiffer(src, dst, tolerance)) {
      await fs.copyFile(src, dst)
      stats.replaced++
    } else {
      stats.kept++
    }
  }
  for (const name of dstFiles) {
    if (name === 'manifest.json' || srcFrames.includes(name)) continue
    await fs.rm(path.join(dstDir, name))
    stats.removed++
  }

  const next = await fs.readFile(path.join(srcDir, 'manifest.json'), 'utf8').catch(() => null)
  const current = await fs.readFile(path.join(dstDir, 'manifest.json'), 'utf8').catch(() => null)
  if (next === null) {
    if (current !== null) await fs.rm(path.join(dstDir, 'manifest.json'))
  } else if (current === null || manifestKey(current) !== manifestKey(next)) {
    await fs.writeFile(path.join(dstDir, 'manifest.json'), next)
    stats.manifestsWritten++
  }
  return stats
}

/** Every file under `dir`, counted (for a removed variant or flow). */
export async function countFiles(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter(e => e.isFile() && isFrame(e.name)).length
}

/** The summary the screenshots PR carries. */
export function summaryMarkdown(stats: SyncStats, skippedVariants: number): string {
  return [
    '| Frames | |',
    '|---|---:|',
    `| kept (look the same, committed file unchanged) | ${stats.kept} |`,
    `| replaced (look different) | ${stats.replaced} |`,
    `| added | ${stats.added} |`,
    `| removed | ${stats.removed} |`,
    '',
    `Manifests rewritten: ${stats.manifestsWritten}. Variants whose flow did not pass (kept as published): ${skippedVariants}.`
  ].join('\n')
}
