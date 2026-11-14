#!/usr/bin/env bun
// Builds the two-minute demo video (.github/media/markoto-demo.mp4 + its
// poster, and the copies the /demo page serves from public/media/) from
// recorded footage, rendered cards and the music. See README.md here.
//
//   bun run demo:video                     # cut from the recorded footage
//   bun run demo:video --capture           # record the footage first (needs the flow stack)
//   bun run demo:video --review <dir>      # also: a copy + a contact sheet (a frame every 4 s) in <dir>
//
// Needs ffmpeg with libx264 (FFMPEG=/path/to/ffmpeg if the one on PATH has
// none) and Playwright's Chromium.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page } from '@playwright/test'
import { BACKGROUND, HEIGHT, SCREEN, WIDTH, cardHtml, posterHtml, windowHtml } from './cards'
import { POSTER, editDecisionList, type Card, type ClipTime, type Segment } from './edl'

const ROOT = path.resolve(import.meta.dir, '../..')
const OUT_DIR = path.join(ROOT, 'tests/e2e/output/demo-video')
/** Recorded clips: <mode>/<scene>/{f*.png, clip.json} (the tour recorder's layout). */
const FOOTAGE = process.env.DEMO_VIDEO_FOOTAGE_DIR ?? path.join(OUT_DIR, 'footage')
const WORK = path.join(OUT_DIR, 'work')
/** The finished cut. Not committed: the /demo page serves the hashed copy in public/media/, the README links a GitHub attachment. */
const VIDEO = path.join(OUT_DIR, 'markoto-demo.mp4')
const POSTER_FILE = path.join(ROOT, '.github/media/markoto-demo-poster.webp')
const PUBLIC_MEDIA = path.join(ROOT, 'public/media')
const PUBLIC_MANIFEST = path.join(ROOT, 'shared/media/demoVideo.ts')
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const FPS = 30
/** GitHub accepts video attachments up to 10 MB: stay below with room to spare. */
const SIZE_BUDGET_BYTES = 9_600_000
const FADE = 0.22

interface ClipJson { fps: number, frames: Array<{ file: string, repeat: number }>, beats?: Array<{ pages: string[] }> }

function run(cmd: string[], opts: { quiet?: boolean } = {}): string {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', cwd: ROOT, env: process.env })
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd[0]} failed (${proc.exitCode}):\n${proc.stderr.toString().slice(-3000)}`)
  }
  if (!opts.quiet) process.stdout.write('.')
  return proc.stdout.toString()
}

function ffmpeg(args: string[]): void {
  run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', ...args])
}

function checkFfmpeg(): void {
  const encoders = run([FFMPEG, '-hide_banner', '-encoders'], { quiet: true })
  if (!/\blibx264\b/.test(encoders)) {
    throw new Error(`${FFMPEG} has no libx264 encoder. Install an ffmpeg build with it, or point FFMPEG at one.`)
  }
}

function probeDuration(file: string): number {
  const ffprobe = FFMPEG.endsWith('ffmpeg') ? FFMPEG.replace(/ffmpeg$/, 'ffprobe') : 'ffprobe'
  const out = run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { quiet: true })
  const d = Number(out.trim())
  if (!Number.isFinite(d) || d <= 0) throw new Error(`cannot read the duration of ${file}`)
  return d
}

// Footage

function loadClip(scene: string): { dir: string, clip: ClipJson, timeline: string[] } {
  const dir = path.join(FOOTAGE, 'light', scene)
  const file = path.join(dir, 'clip.json')
  if (!existsSync(file)) throw new Error(`no footage for "${scene}" (${file}); record it with --capture`)
  const clip: ClipJson = JSON.parse(readFileSync(file, 'utf8'))
  // One entry per frame of the clip's own timeline.
  const timeline = clip.frames.flatMap(f => Array.from({ length: f.repeat }, () => path.join(dir, f.file)))
  return { dir, clip, timeline }
}

function clipTime(t: ClipTime, length: number): number {
  if (t === 'end') return length
  return t < 0 ? Math.max(0, length + t) : Math.min(t, length)
}

/** The clip frame shown at each output frame of a slot `frames` long. */
function clipFrames(scene: string, parts: Array<[number, ClipTime]>, frames: number): { files: string[], speed: number } {
  const { clip, timeline } = loadClip(scene)
  const length = timeline.length / clip.fps
  const spans = parts.map(([a, b]) => [clipTime(a, length), clipTime(b, length)] as const)
  const total = spans.reduce((s, [a, b]) => s + Math.max(0, b - a), 0)
  if (total <= 0) throw new Error(`empty footage window for ${scene}`)
  const speed = total / (frames / FPS)
  const files: string[] = []
  for (let k = 0; k < frames; k++) {
    let t = (k / FPS) * speed
    let at = spans[spans.length - 1]?.[1] ?? 0
    for (const [a, b] of spans) {
      if (t < b - a) {
        at = a + t
        break
      }
      t -= b - a
    }
    const idx = Math.min(timeline.length - 1, Math.max(0, Math.floor(at * clip.fps)))
    files.push(timeline[idx] ?? '')
  }
  return { files, speed }
}

// Segments: a numbered frame sequence (symlinks) → one lossless-ish
// intermediate per segment, all with the same parameters so they concat.

async function linkSequence(dir: string, files: string[]): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await Promise.all(files.map((f, i) => fs.symlink(f, path.join(dir, `${String(i).padStart(5, '0')}.png`))))
}

function encodeIntermediate(seqDir: string, out: string, frames: number, filter: string, extraInputs: string[] = []): void {
  ffmpeg([
    '-framerate', String(FPS), '-i', path.join(seqDir, '%05d.png'), ...extraInputs,
    '-filter_complex', filter, '-map', '[v]',
    '-frames:v', String(frames), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', '-pix_fmt', 'yuv420p', out
  ])
}

const BG_HEX = `0x${BACKGROUND.slice(1)}`

async function renderClipSegment(seg: Extract<Segment, { kind: 'clip' }>, frames: number, out: string, windowPng: string): Promise<number> {
  const { files, speed } = clipFrames(seg.scene, seg.parts, frames)
  const seq = path.join(WORK, 'seq', path.basename(out, '.mp4'))
  await linkSequence(seq, files)
  const d = frames / FPS
  const fadeIn = `fade=t=in:st=0:d=${FADE}:color=${BG_HEX}`
  const fadeOut = `fade=t=out:st=${(d - FADE).toFixed(3)}:d=${FADE}:color=${BG_HEX}`
  // Short montage shots cut hard; full scenes dip from and to the page colour.
  const fades = d < 1 ? '' : `,${fadeIn},${fadeOut}`
  encodeIntermediate(seq, out, frames,
    `[0:v]scale=${SCREEN.w}:${SCREEN.h}:flags=lanczos[s];[1:v][s]overlay=${SCREEN.x}:${SCREEN.y}:shortest=1,format=yuv420p${fades}[v]`,
    ['-loop', '1', '-framerate', String(FPS), '-i', windowPng])
  return speed
}

async function renderPage(page: Page, html: string, file: string): Promise<void> {
  await Bun.write(file, html)
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(['300 100px "Fraunces Variable"', 'italic 400 100px "Fraunces Variable"', '400 40px "Inter Variable"', '400 30px "JetBrains Mono Variable"'].map(f => document.fonts.load(f)))
    await Promise.all([...document.images].map(img => img.decode().catch(() => undefined)))
  })
}

async function renderCardSegment(page: Page, seg: Extract<Segment, { kind: 'card' }>, frames: number, out: string, fadeOut: boolean): Promise<void> {
  const name = path.basename(out, '.mp4')
  const shots = path.join(WORK, 'cards', name)
  await fs.rm(shots, { recursive: true, force: true })
  await fs.mkdir(shots, { recursive: true })
  const pdfPages = seg.card.type === 'pdf' ? pdfPagesOf(seg.card.scene) : []
  await renderPage(page, cardHtml(ROOT, seg.card, pdfPages), path.join(shots, 'card.html'))
  const animEnd = await page.evaluate(() => Reflect.get(window, '__end')() as number)
  // Animated frames until nothing moves, then the last one holds.
  const moving = Math.min(frames, Math.ceil(animEnd * FPS) + 1)
  const files: string[] = []
  for (let k = 0; k < moving; k++) {
    await page.evaluate(t => Reflect.get(window, '__render')(t), k / FPS)
    const file = path.join(shots, `${String(k).padStart(5, '0')}.png`)
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })
    files.push(file)
  }
  const last = files[files.length - 1] ?? ''
  while (files.length < frames) files.push(last)
  const seq = path.join(WORK, 'seq', name)
  await linkSequence(seq, files)
  const d = frames / FPS
  const filter = fadeOut ? `[0:v]format=yuv420p,fade=t=out:st=${(d - 1).toFixed(3)}:d=1:color=${BG_HEX}[v]` : '[0:v]format=yuv420p[v]'
  encodeIntermediate(seq, out, frames, filter)
}

function pdfPagesOf(scene: string): string[] {
  const { dir, clip } = loadClip(scene)
  const pages = clip.beats?.[0]?.pages ?? []
  if (!pages.length) throw new Error(`${scene} has no PDF pages (clip.json beats)`)
  return pages.map(p => path.join(dir, p))
}

// Capture

async function capture(): Promise<void> {
  const env = { ...process.env, TOUR_OUTPUT_DIR: FOOTAGE, PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://markoto.localhost:3001' }
  for (const [config, project] of [['tests/e2e/tour/playwright.config.ts', 'tour-light'], ['tests/e2e/demo-video/playwright.config.ts', 'video-light']] as const) {
    const proc = Bun.spawn(['bunx', 'playwright', 'test', '-c', config, `--project=${project}`], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' })
    const code = await proc.exited
    if (code !== 0) throw new Error(`capture failed: ${config} (exit ${code})`)
  }
}

// Main

function shortHash(file: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex').slice(0, 10)
}

// Captions: the cards' text, each shown from its card until the next card
// (the video has music and no speech; this is what a viewer reads on it).

function plain(title: string): string {
  return title.replaceAll('*', '')
}

function cardText(card: Card): string {
  switch (card.type) {
    case 'chapter':
    case 'terminal': return `${String(card.n).padStart(2, '0')} · ${card.label}\n${plain(card.title)} ${card.sub}`
    case 'hood': return `${plain(card.title)}\n${card.items.join(' · ')}`
    case 'pdf': return card.caption
    case 'claim': return `${plain(card.title)} ${card.sub}`
    case 'end': return `${plain(card.title)} ${card.sub}\n${card.footer}`
  }
}

function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

function captionsVtt(edl: Segment[], end: number): string {
  const cards = edl.filter((s): s is Extract<Segment, { kind: 'card' }> => s.kind === 'card')
  const cues = cards.map((seg, i) => `${vttTime(seg.at)} --> ${vttTime(cards[i + 1]?.at ?? end)}\n${cardText(seg.card)}`)
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

async function publishCopies(seconds: number, captions: string): Promise<void> {
  await fs.mkdir(PUBLIC_MEDIA, { recursive: true })
  for (const f of readdirSync(PUBLIC_MEDIA)) {
    if (/^markoto-demo(-poster|-captions)?-[0-9a-f]+\.(mp4|webp|vtt)$/.test(f)) await fs.rm(path.join(PUBLIC_MEDIA, f))
  }
  const captionsTmp = path.join(WORK, 'captions.vtt')
  await Bun.write(captionsTmp, captions)
  const video = `markoto-demo-${shortHash(VIDEO)}.mp4`
  const poster = `markoto-demo-poster-${shortHash(POSTER_FILE)}.webp`
  const track = `markoto-demo-captions-${shortHash(captionsTmp)}.vtt`
  await fs.copyFile(VIDEO, path.join(PUBLIC_MEDIA, video))
  await fs.copyFile(POSTER_FILE, path.join(PUBLIC_MEDIA, poster))
  await fs.copyFile(captionsTmp, path.join(PUBLIC_MEDIA, track))
  await fs.mkdir(path.dirname(PUBLIC_MANIFEST), { recursive: true })
  await Bun.write(PUBLIC_MANIFEST, `// Generated by scripts/demo-video/build.ts (bun run demo:video). Do not edit.
// The demo video the /demo page plays: content-hashed names under
// public/media/, so a new cut gets a new URL and the files can be cached
// for a year (server/utils/rendering/mediaAssetHeaders.ts).

export const DEMO_VIDEO = {
  src: '/media/${video}',
  poster: '/media/${poster}',
  /** WebVTT captions (English): the text of the video's cards. */
  captions: '/media/${track}',
  width: ${WIDTH},
  height: ${HEIGHT},
  /** Whole seconds. */
  durationSeconds: ${Math.round(seconds)},
  /** When this cut was built (VideoObject uploadDate). */
  published: '${new Date().toISOString().slice(0, 10)}'
} as const
`)
}

function contactSheet(video: string, out: string): void {
  // Timestamps only where this ffmpeg build has drawtext (static builds often lack it).
  const hasDrawtext = /\bdrawtext\b/.test(run([FFMPEG, '-hide_banner', '-filters'], { quiet: true }))
  const stamp = hasDrawtext ? `,drawtext=text='%{pts\\:hms}':x=8:y=8:fontsize=22:fontcolor=0xB5371F` : ''
  ffmpeg(['-i', video, '-vf', `fps=1/4,scale=480:-1${stamp},tile=6x5:padding=6:color=${BG_HEX}`, '-frames:v', '1', '-q:v', '3', out])
}

/** Every segment as an intermediate file, in order (for the concat demuxer). */
async function renderSegments(page: Page, edl: Segment[], end: number): Promise<string[]> {
  const segs = path.join(WORK, 'segments')
  await fs.rm(segs, { recursive: true, force: true })
  await fs.mkdir(segs, { recursive: true })
  const windowPng = path.join(WORK, 'window.png')
  await renderPage(page, windowHtml(ROOT), path.join(WORK, 'window.html'))
  await page.screenshot({ path: windowPng })

  const files: string[] = []
  console.log('segment                     start   len   speed')
  for (const [i, seg] of edl.entries()) {
    const next = edl[i + 1]?.at ?? end
    const frames = Math.round(next * FPS) - Math.round(seg.at * FPS)
    if (frames <= 0) throw new Error(`segment ${i} has no length`)
    const out = path.join(segs, `${String(i).padStart(2, '0')}-${seg.kind === 'clip' ? seg.scene : seg.card.type}.mp4`)
    let speed = 1
    if (seg.kind === 'clip') speed = await renderClipSegment(seg, frames, out, windowPng)
    else await renderCardSegment(page, seg, frames, out, i === edl.length - 1)
    files.push(out)
    logSegment(seg, frames, speed)
  }
  return files
}

function logSegment(seg: Segment, frames: number, speed: number): void {
  const label = seg.kind === 'clip' ? `clip ${seg.scene}` : `card ${seg.card.type}${'n' in seg.card ? ` ${seg.card.n}` : ''}`
  const rate = seg.kind === 'clip' ? `${speed.toFixed(2)}x${speed > 4 ? '  (fast)' : ''}` : ''
  console.log(`\n${label.padEnd(26)} ${seg.at.toFixed(1).padStart(6)} ${(frames / FPS).toFixed(1).padStart(5)} ${rate}`)
}

/** The poster: the claim beside the finished report. */
async function renderPoster(page: Page, end: number): Promise<void> {
  const { timeline } = loadClip(POSTER.scene)
  const posterPng = path.join(WORK, 'poster.png')
  const shot = path.join(WORK, 'poster-shot.png')
  ffmpeg(['-i', timeline[timeline.length - 1] ?? '', '-vf', 'scale=1440:-1:flags=lanczos', shot])
  await renderPage(page, posterHtml(ROOT, POSTER, shot, Math.round(end / 60)), path.join(WORK, 'poster.html'))
  await page.screenshot({ path: posterPng })
  ffmpeg(['-i', posterPng, '-c:v', 'libwebp', '-quality', '86', POSTER_FILE])
}

/** Join the segments and encode once, in two passes, to the size budget; the music is copied. */
function encodeFinal(segments: string[], music: string, end: number): string {
  const concat = path.join(WORK, 'concat.txt')
  writeFileSync(concat, `${segments.map(f => `file '${f}'`).join('\n')}\n`)
  const joined = path.join(WORK, 'joined.mp4')
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', joined])
  const totalFrames = String(Math.round(end * FPS))
  const audioBits = 140_000
  const videoBits = Math.floor((SIZE_BUDGET_BYTES * 8) / end - audioBits)
  const x264 = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-tune', 'animation', '-b:v', String(videoBits), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 4)]
  const passlog = path.join(WORK, 'x264pass')
  ffmpeg(['-i', joined, '-frames:v', totalFrames, ...x264, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'mp4', '/dev/null'])
  const out = path.join(WORK, 'markoto-demo.mp4')
  ffmpeg(['-i', joined, '-i', music, '-map', '0:v', '-map', '1:a', '-frames:v', totalFrames, ...x264, '-pass', '2', '-passlogfile', passlog, '-c:a', 'copy', '-movflags', '+faststart', out])
  return out
}

function parseArgs(argv: string[]): { capture: boolean, reviewDir?: string } {
  const reviewAt = argv.indexOf('--review')
  const reviewDir = reviewAt >= 0 ? argv[reviewAt + 1] : undefined
  if (reviewAt >= 0 && !reviewDir) throw new Error('--review needs a directory')
  return { capture: argv.includes('--capture'), reviewDir }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  checkFfmpeg()
  if (args.capture) await capture()

  await fs.mkdir(WORK, { recursive: true })
  // The music: the audio track of the committed video in public/media/,
  // copied bit for bit (Andrii Poradovskyi via Pixabay, credited in NOTICE).
  const music = path.join(WORK, 'music.m4a')
  if (!existsSync(music)) {
    const committed = readdirSync(PUBLIC_MEDIA).find(f => /^markoto-demo-[0-9a-f]+\.mp4$/.test(f))
    if (!committed) throw new Error('no committed demo video in public/media/ to take the music from')
    ffmpeg(['-i', path.join(PUBLIC_MEDIA, committed), '-vn', '-c:a', 'copy', music])
  }
  // Rounded up to a whole frame: the video covers the whole track, so the
  // mux never drops the last audio frame (rebuilds copy the music from the
  // committed video, a dropped frame would shorten it every time).
  const end = Math.ceil(probeDuration(music) * FPS) / FPS
  const mcpTools = readdirSync(path.join(ROOT, 'server/mcp/tools')).filter(f => f.endsWith('.ts')).length
  const edl = editDecisionList(mcpTools)

  const browser = await chromium.launch({ args: ['--font-render-hinting=none'] })
  let segments: string[]
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
    segments = await renderSegments(page, edl, end)
    await renderPoster(page, end)
  } finally {
    await browser.close()
  }

  await fs.copyFile(encodeFinal(segments, music, end), VIDEO)
  await publishCopies(end, captionsVtt(edl, end))
  const size = (await fs.stat(VIDEO)).size
  console.log(`\nwrote ${path.relative(ROOT, VIDEO)} (${(size / 1e6).toFixed(2)} MB, ${probeDuration(VIDEO).toFixed(2)} s) and ${path.relative(ROOT, POSTER_FILE)}`)
  if (size > 10_000_000) throw new Error('the video is over 10 MB; lower SIZE_BUDGET_BYTES')
  if (args.reviewDir) {
    await fs.mkdir(args.reviewDir, { recursive: true })
    await fs.copyFile(VIDEO, path.join(args.reviewDir, 'markoto-demo.mp4'))
    contactSheet(VIDEO, path.join(args.reviewDir, 'contact-sheet.jpg'))
    console.log(`review copy + contact sheet in ${args.reviewDir}`)
  }
}

await main()
