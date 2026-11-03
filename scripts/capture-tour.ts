#!/usr/bin/env bun
// Product-tour videos (WP11): record → encode → manifest.
//
//   bun scripts/capture-tour.ts            # record (Playwright) + encode
//   bun scripts/capture-tour.ts --encode   # only encode $TOUR_OUTPUT_DIR → public/tour
//   bun scripts/capture-tour.ts --record   # only record
//   … --only write,themes                  # encode only these scenes
//   … <playwright args>                    # anything else, e.g. --project=tour-light -g "Tour: write$"
//
// Recording drives the real app with tests/e2e/tour/*.capture.ts
// (playwright.tour.config.ts: 1440×900 @2x, light + dark) and writes PNG
// frames + clip.json per scene (see tests/e2e/tour/fixture.ts). It needs
// the flow test stack and an app server in the hosted shape (no
// NUXT_AI_DEFAULT_* — the AI runs on the user's own key), plus
// MISTRAL_API_KEY / JINA_AI_API_KEY in the stack's LiteLLM and this shell.
// PLAYWRIGHT_BASE_URL overrides the default http://markoto.localhost:3001;
// TOUR_OUTPUT_DIR moves the (large) frame output, e.g. onto a tmpfs.
//
// Encoding needs ffmpeg with libsvtav1 and libx264. Per scene and color
// mode: the desktop video (AV1 + H.264 MP4, 1728 px wide — a 2x display
// of the pinned stage), the phone cut (the scene's focus rect, 720 px),
// and posters (the clip's last frame) as webp in a few widths. Each loop
// ends on a hold and cross-fades back to its first frame. The hero's
// poster is the finished report from the "write" clip.

import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { spawn } from 'bun'
import {
  TOUR_SCENE_IDS,
  TOUR_BEAT_IDS,
  parseTourManifest,
  type TourBeat,
  type TourBeatId,
  type TourImage,
  type TourManifest,
  type TourScene,
  type TourSceneId,
  type TourVideo
} from '../shared/tour/manifest'

const OUTPUT = process.env.TOUR_OUTPUT_DIR ?? 'tests/e2e/output/tour'
const PUBLIC = 'public/tour'
const MANIFEST = path.join(PUBLIC, 'manifest.json')
type Mode = 'light' | 'dark'

const DESKTOP_WIDTH = 1728
const PHONE_WIDTH = 720
/** Per-file byte budgets from the WP11 brief: ≤ 3 MB per desktop scene, ≤ 1 MB per phone cut. */
const DESKTOP_VIDEO_BUDGET = 3 * 1024 * 1024
const PHONE_VIDEO_BUDGET = 1024 * 1024
const POSTER_WIDTHS = [1920, 1280, 800] as const
const PHONE_POSTER_WIDTHS = [1080, 720] as const
const LOOP_BLEND_FRAMES = 6

interface Rect { x: number, y: number, w: number, h: number }
interface ClipFrame { file: string, repeat: number }
interface RawClip {
  id: TourSceneId
  mode: Mode
  fps: number
  viewport: { w: number, h: number }
  description: string
  focus: Rect
  frames: ClipFrame[]
  beats: Array<{ id: TourBeatId, t: [number, number], description: string, pages: string[] }>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isSceneId(v: unknown): v is TourSceneId {
  return typeof v === 'string' && TOUR_SCENE_IDS.some(id => id === v)
}
function isBeatId(v: unknown): v is TourBeatId {
  return typeof v === 'string' && TOUR_BEAT_IDS.some(id => id === v)
}
function toRect(v: unknown): Rect | null {
  if (!isRecord(v)) return null
  const r = { x: Number(v.x), y: Number(v.y), w: Number(v.w), h: Number(v.h) }
  return Object.values(r).every(Number.isFinite) ? r : null
}

async function readClip(mode: Mode, id: TourSceneId): Promise<RawClip | null> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(OUTPUT, mode, id, 'clip.json'), 'utf8'))
    if (!isRecord(raw) || !isSceneId(raw.id) || !Array.isArray(raw.frames)) return null
    const vp = toRect({ x: 0, y: 0, ...(isRecord(raw.viewport) ? raw.viewport : {}) })
    const focus = toRect(raw.focus)
    if (!vp || !focus) return null
    const frames = raw.frames.filter(isRecord).map(f => ({ file: String(f.file), repeat: Math.max(1, Number(f.repeat) || 1) }))
    if (!frames.length) return null
    const beats = (Array.isArray(raw.beats) ? raw.beats : []).filter(isRecord).flatMap((b) => {
      if (!isBeatId(b.id) || !Array.isArray(b.t) || !Array.isArray(b.pages)) return []
      return [{ id: b.id, t: [Number(b.t[0]), Number(b.t[1])] as [number, number], description: String(b.description ?? ''), pages: b.pages.map(String) }]
    })
    return {
      id: raw.id,
      mode,
      fps: Number(raw.fps) || 12,
      viewport: { w: vp.w, h: vp.h },
      description: String(raw.description ?? ''),
      focus,
      frames,
      beats
    }
  } catch {
    return null
  }
}

/**
 * Phones show the focus rect in a frame of the same shape. A rect taken
 * from an element box can be a thin strip, so grow it around its centre
 * to a readable shape: ≥ FOCUS_MIN_W wide, between 4:3 and 1:1, inside
 * the viewport.
 */
const FOCUS_MIN_W = 560
export function normalizeFocus(f: Rect, vp: { w: number, h: number }): Rect {
  let w = Math.max(f.w + 48, FOCUS_MIN_W)
  let h = Math.max(f.h + 48, w * 0.75)
  if (h > w) w = h
  w = Math.min(w, vp.w)
  h = Math.min(h, vp.h, w)
  const cx = f.x + f.w / 2
  const cy = f.y + f.h / 2
  const x = Math.min(Math.max(0, cx - w / 2), vp.w - w)
  const y = Math.min(Math.max(0, cy - h / 2), vp.h - h)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

async function run(cmd: string[]): Promise<void> {
  const proc = spawn({ cmd, stdout: 'ignore', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`${cmd[0]} failed (${code}): ${err.slice(-1500)}`)
  }
}

const rel = (file: string) => `/${path.relative('public', file)}`

async function webpVariants(src: string | Buffer, outBase: string, widths: readonly number[], crop?: { left: number, top: number, width: number, height: number }): Promise<TourImage> {
  const variants: Array<{ src: string, width: number, height: number }> = []
  for (const w of widths) {
    let img = sharp(src)
    if (crop) img = img.extract(crop)
    const resized = await img.resize({ width: w, withoutEnlargement: true }).webp({ quality: 84, effort: 6, smartSubsample: true }).toBuffer({ resolveWithObject: true })
    const file = `${outBase}-${resized.info.width}.webp`
    await fs.writeFile(file, resized.data)
    variants.push({ src: rel(file), width: resized.info.width, height: resized.info.height })
  }
  const [first, ...rest] = variants
  if (!first) throw new Error('no poster variants')
  return { ...first, srcset: rest.filter(v => v.width !== first.width).map(v => ({ src: v.src, width: v.width })) }
}

/** The concat list for ffmpeg: every frame with its duration, the end hold, then a cross-fade back to the start. */
async function writeConcat(clip: RawClip, dir: string, work: string): Promise<{ list: string, seconds: number }> {
  const lines: string[] = []
  let seconds = 0
  const add = (file: string, frames: number) => {
    const d = frames / clip.fps
    lines.push(`file '${file.replace(/'/g, `'\\''`)}'`, `duration ${d.toFixed(5)}`)
    seconds += d
  }
  for (const f of clip.frames) add(path.resolve(dir, f.file), f.repeat)
  const first = clip.frames[0]
  const last = clip.frames[clip.frames.length - 1]
  if (first && last && first.file !== last.file) {
    const top = await sharp(path.resolve(dir, first.file)).toBuffer()
    for (let k = 1; k <= LOOP_BLEND_FRAMES; k++) {
      const overlay = await sharp(top).ensureAlpha(k / (LOOP_BLEND_FRAMES + 1)).png().toBuffer()
      const file = path.join(work, `blend-${k}.png`)
      await sharp(path.resolve(dir, last.file)).composite([{ input: overlay }]).png().toFile(file)
      add(file, 1)
    }
  }
  // The concat demuxer needs the last file listed twice for its duration to count.
  const tail = lines[lines.length - 2]
  if (tail) lines.push(tail)
  const list = path.join(work, 'frames.txt')
  await fs.writeFile(list, `${lines.join('\n')}\n`)
  return { list, seconds }
}

interface EncodeTarget {
  /** ffmpeg filter that crops + scales the 2× frames for this cut. */
  filter: string
  /** Starting CRFs; raised in steps until the file fits `budget`. */
  crf: { av1: number, h264: number }
  /** Bytes per file. Dense scenes (a whole report typed + scrolled) would otherwise blow past it. */
  budget: number
}

/** CRF headroom above the starting value before we accept an over-budget file. */
const MAX_CRF_STEP = 9
const CRF_STEP = 3

async function encodeOne(cmd: string[], crf: number, budget: number, file: string): Promise<number> {
  for (let c = crf; ; c += CRF_STEP) {
    await run([...cmd, '-crf', String(c), file])
    const { size } = await fs.stat(file)
    if (size <= budget || c >= crf + MAX_CRF_STEP) {
      if (size > budget) console.warn(`[capture-tour] ${path.relative(PUBLIC, file)} is ${Math.round(size / 1024)} KB at CRF ${c} (budget ${Math.round(budget / 1024)} KB)`)
      return c
    }
  }
}

async function encodeVideo(list: string, fps: number, target: EncodeTarget, outBase: string): Promise<{ av1: string, h264: string, width: number, height: number }> {
  const av1 = `${outBase}.av1.mp4`
  const h264 = `${outBase}.h264.mp4`
  const common = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `${target.filter},format=yuv420p`, '-r', String(fps), '-an']
  await encodeOne([...common, '-c:v', 'libsvtav1', '-preset', '5', '-g', String(fps * 10), '-svtav1-params', 'tune=0', '-movflags', '+faststart'], target.crf.av1, target.budget, av1)
  await encodeOne([...common, '-c:v', 'libx264', '-preset', 'slow', '-tune', 'stillimage', '-profile:v', 'high', '-level', '4.0', '-g', String(fps * 10), '-movflags', '+faststart'], target.crf.h264, target.budget, h264)
  const meta = await sharp(await firstFrameOf(h264)).metadata()
  return { av1, h264, width: meta.width ?? 0, height: meta.height ?? 0 }
}

async function firstFrameOf(video: string): Promise<Buffer> {
  const proc = spawn({ cmd: ['ffmpeg', '-loglevel', 'error', '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], stdout: 'pipe', stderr: 'ignore' })
  const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer())
  await proc.exited
  return buf
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

async function encodeScene(clip: RawClip): Promise<{ poster: TourImage, phonePoster: TourImage, video: TourVideo, phoneVideo: TourVideo, seconds: number, focus: Rect }> {
  const dir = path.join(OUTPUT, clip.mode, clip.id)
  const out = path.join(PUBLIC, clip.mode, clip.id)
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(out, { recursive: true })
  const work = path.join(OUTPUT, '_work', clip.mode, clip.id)
  await fs.mkdir(work, { recursive: true })
  const { list, seconds } = await writeConcat(clip, dir, work)
  const lastFrame = clip.frames[clip.frames.length - 1]
  if (!lastFrame) throw new Error('empty clip')
  const lastPath = path.resolve(dir, lastFrame.file)
  const meta = await sharp(lastPath).metadata()
  const dpr = (meta.width ?? clip.viewport.w * 2) / clip.viewport.w
  const focus = normalizeFocus(clip.focus, clip.viewport)
  const crop = { left: even(focus.x * dpr), top: even(focus.y * dpr), width: even(focus.w * dpr), height: even(focus.h * dpr) }

  const desktop = await encodeVideo(list, clip.fps, { filter: `scale=${DESKTOP_WIDTH}:-2:flags=lanczos`, crf: { av1: 34, h264: 24 }, budget: DESKTOP_VIDEO_BUDGET }, path.join(out, 'video'))
  const phone = await encodeVideo(list, clip.fps, { filter: `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},scale=${PHONE_WIDTH}:-2:flags=lanczos`, crf: { av1: 32, h264: 23 }, budget: PHONE_VIDEO_BUDGET }, path.join(out, 'phone'))
  const poster = await webpVariants(lastPath, path.join(out, 'poster'), POSTER_WIDTHS)
  const phonePoster = await webpVariants(lastPath, path.join(out, 'phone-poster'), PHONE_POSTER_WIDTHS, crop)
  return {
    poster,
    phonePoster,
    video: { av1: rel(desktop.av1), h264: rel(desktop.h264), width: desktop.width, height: desktop.height },
    phoneVideo: { av1: rel(phone.av1), h264: rel(phone.h264), width: phone.width, height: phone.height },
    seconds,
    focus
  }
}

async function encodePages(clip: RawClip): Promise<TourBeat[]> {
  const beats: TourBeat[] = []
  for (const b of clip.beats) {
    const pages: TourImage[] = []
    for (const [i, f] of b.pages.entries()) {
      pages.push(await webpVariants(path.join(OUTPUT, clip.mode, clip.id, f), path.join(PUBLIC, clip.mode, clip.id, `${b.id}-${i}`), [720, 400]))
    }
    beats.push({ id: b.id, t: b.t, description: b.description, pages })
  }
  return beats
}

async function encode(only: ReadonlySet<string> | null): Promise<void> {
  const current: TourManifest = parseTourManifest(JSON.parse(await fs.readFile(MANIFEST, 'utf8')))
  const byId = new Map(current.scenes.map(s => [s.id, s]))
  let viewport = current.viewport
  let captured = 0
  for (const id of TOUR_SCENE_IDS) {
    if (only && !only.has(id)) continue
    const light = await readClip('light', id)
    const dark = await readClip('dark', id)
    if (!light || !dark) {
      if (light || dark) console.warn(`[capture-tour] ${id}: only one color mode recorded — keeping the previous entry`)
      continue
    }
    viewport = light.viewport
    const enc = { light: await encodeScene(light), dark: await encodeScene(dark) }
    const beats = await encodePages(light)
    const scene: TourScene = {
      id,
      description: light.description,
      poster: { light: enc.light.poster, dark: enc.dark.poster },
      video: { light: enc.light.video, dark: enc.dark.video },
      duration: Math.round(enc.light.seconds * 100) / 100,
      focus: enc.light.focus,
      phone: {
        poster: { light: enc.light.phonePoster, dark: enc.dark.phonePoster },
        video: { light: enc.light.phoneVideo, dark: enc.dark.phoneVideo }
      },
      ...(beats.length ? { beats } : {})
    }
    byId.set(id, scene)
    captured++
    console.log(`[capture-tour] ${id}: ${scene.duration}s`)
    if (id === 'write') {
      // The hero is the finished report: the write clip's last frame.
      byId.set('hero', {
        id: 'hero',
        description: 'The markoto editor with the finished Quaybridge report.',
        poster: scene.poster,
        focus: scene.focus,
        phone: { poster: { light: enc.light.phonePoster, dark: enc.dark.phonePoster } }
      })
    }
  }
  const next: TourManifest = parseTourManifest({
    version: 2,
    viewport,
    scenes: TOUR_SCENE_IDS.map(id => byId.get(id) ?? { id })
  })
  await fs.writeFile(MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`[capture-tour] wrote ${MANIFEST} (${captured} scene(s) encoded)`)
}

async function record(args: string[]): Promise<number> {
  const proc = spawn({
    cmd: ['bunx', 'playwright', 'test', '-c', 'playwright.tour.config.ts', ...args],
    env: { ...process.env, PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://markoto.localhost:3001' },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  return await proc.exited
}

async function main(): Promise<void> {
  // Our flags: --encode, --record, --only <ids>. Everything else goes to
  // Playwright (a `--` separator is optional — bun drops one that directly
  // follows the script path, so never rely on it).
  const own = new Set<string>()
  let only: Set<string> | null = null
  const pwArgs: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--encode' || a === '--record') own.add(a)
    else if (a === '--only') only = new Set((argv[++i] ?? '').split(',').filter(Boolean))
    else if (a !== '--') pwArgs.push(a)
  }
  if (!own.has('--encode')) {
    const code = await record(pwArgs)
    if (code !== 0) console.warn(`[capture-tour] some captures failed (exit ${code}) — encoding what was recorded`)
  }
  // `--only write,themes` encodes just those scenes and keeps the rest of the manifest.
  if (!own.has('--record')) await encode(only)
}

await main()
