// Product tour (WP11) — the asset contract between the capture pipeline
// (`scripts/capture-tour.ts` + `tests/e2e/tour/*.capture.ts`) and the
// scroll-driven product page (`app/components/landing/ProductTour.vue`).
//
// `public/tour/manifest.json` describes, per scene: a poster still (light
// + dark, `srcset` widths) and a short looping video (AV1 + H.264, light +
// dark), each also in a phone cut — the region of the capture that
// matters, cropped and encoded small. Videos are recorded step by step
// from the real app with a virtual cursor baked in; the page only plays
// them while their scene is on stage.
//
// The scroll choreography is CSS (`animation-range` on view timelines);
// the helpers below compute those ranges and the generated keyframes for
// the stage that alternates sides. All pure, so the page and the unit
// tests (`tests/unit/tourManifest.test.ts`) share them.

import { z } from 'zod'

/** Scene ids, in page order. The copy for each lives under `tour.scenes.<id>` in i18n. */
export const TOUR_SCENE_IDS = [
  'hero',
  'write',
  'rich',
  'themes',
  'collab',
  'ai',
  'knowledge',
  'history',
  'share',
  'yours',
  'cta'
] as const
export type TourSceneId = typeof TOUR_SCENE_IDS[number]

/** Beat ids double as i18n keys for their alt text (`tour.alt.<id>`). */
export const TOUR_BEAT_IDS = ['sharePdf'] as const
export type TourBeatId = typeof TOUR_BEAT_IDS[number]

const fraction = z.number().min(0).max(1)
const positive = z.number().positive()
const nonNegative = z.number().min(0)
// Site-relative asset path. No scheme, no protocol-relative `//`, no `..`.
const assetPath = z.string().regex(/^\/(?!\/)[\w\-./]+$/, 'must be a site-relative path').refine(
  p => !p.split('/').includes('..'),
  'must not contain ..'
)
const rect = z.object({ x: nonNegative, y: nonNegative, w: positive, h: positive })

export const TourImageSchema = z.object({
  src: assetPath,
  width: positive,
  height: positive,
  /** Extra widths of the same image for `srcset`. */
  srcset: z.array(z.object({ src: assetPath, width: positive })).optional()
})
export type TourImage = z.infer<typeof TourImageSchema>

/** One encode of a scene video: AV1 (preferred) and H.264 (everywhere). */
export const TourVideoSchema = z.object({
  av1: assetPath.optional(),
  h264: assetPath,
  width: positive,
  height: positive
})
export type TourVideo = z.infer<typeof TourVideoSchema>

const perMode = <T extends z.ZodTypeAny>(schema: T) => z.object({ light: schema, dark: schema })

/** The same scene in a phone cut: cropped to `focus`, smaller encodes. */
export const TourPhoneCutSchema = z.object({
  poster: perMode(TourImageSchema),
  video: perMode(TourVideoSchema).optional()
})

/**
 * A later moment of a scene shown over its video: a few document pages
 * that fan out (the exported PDF). Pages are light-only — a PDF is paper.
 */
export const TourBeatSchema = z.object({
  id: z.enum(TOUR_BEAT_IDS),
  t: z.tuple([fraction, fraction]),
  pages: z.array(TourImageSchema).min(2).max(4),
  description: z.string().max(300).optional()
})
export type TourBeat = z.infer<typeof TourBeatSchema>

export const TourSceneSchema = z.object({
  id: z.enum(TOUR_SCENE_IDS),
  /** What the scene shows, in English — capture notes. The page's alt text is `tour.alt.<id>` (i18n). */
  description: z.string().max(400).optional(),
  poster: perMode(TourImageSchema).optional(),
  video: perMode(TourVideoSchema).optional(),
  /** Loop length in seconds. */
  duration: positive.optional(),
  /** The region of the capture the phone cut shows. */
  focus: rect.optional(),
  phone: TourPhoneCutSchema.optional(),
  beats: z.array(TourBeatSchema).max(2).optional()
})
export type TourScene = z.infer<typeof TourSceneSchema>

export const TourManifestSchema = z.object({
  version: z.literal(2),
  /** The coordinate space of the captures (= the capture viewport, CSS px). */
  viewport: z.object({ w: positive, h: positive }),
  scenes: z.array(TourSceneSchema)
}).superRefine((m, ctx) => {
  const ids = m.scenes.map(s => s.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate scene id' })
  const inside = (r: { x: number, y: number, w: number, h: number }) =>
    r.x + r.w <= m.viewport.w + 0.5 && r.y + r.h <= m.viewport.h + 0.5
  m.scenes.forEach((s, i) => {
    if (s.video && !s.poster) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'poster'], message: 'a video needs a poster' })
    if (s.video && !s.duration) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'duration'], message: 'a video needs its duration' })
    if (s.phone && !s.focus) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'focus'], message: 'a phone cut needs its focus rect' })
    if (s.focus && !inside(s.focus)) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'focus'], message: 'focus outside the viewport' })
    s.beats?.forEach((b, j) => {
      if (!s.poster) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'beats', j], message: 'a beat needs the scene underneath' })
      if (b.t[0] >= b.t[1]) ctx.addIssue({ code: 'custom', path: ['scenes', i, 'beats', j, 't'], message: 'empty time range' })
    })
  })
})
export type TourManifest = z.infer<typeof TourManifestSchema>

/** Parse + validate; throws a readable error for a malformed manifest. */
export function parseTourManifest(raw: unknown): TourManifest {
  const result = TourManifestSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(`Invalid tour manifest at ${first?.path.join('.') ?? '?'}: ${first?.message ?? 'unknown error'}`)
  }
  return result.data
}

// ─── Scroll math ──────────────────────────────────────────────────────

/** Scroll length of each scene section, in viewport heights. */
export const SCENE_HEIGHT_VH = 160
/** Height of the hero inside the pinned layout, in viewport heights. */
export const HERO_HEIGHT_VH = 100

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/**
 * Window fraction → the matching `cover` percentage of a section's view
 * timeline. The cover range runs from "section top at viewport bottom"
 * (0%) to "section bottom at viewport top" (100%), i.e. over H + 100vh of
 * scroll; the window starts 50vh in (top at the middle).
 */
export function windowToCover(t: number, heightVh: number = SCENE_HEIGHT_VH): number {
  return clamp01((50 + t * heightVh) / (heightVh + 100)) * 100
}

/**
 * Where a scroll-snap marker sits in a scene section (vh from the
 * section's top, aligned `start`) so that resting on it puts the scene's
 * window at `t` — i.e. the section's top is `t·height − 50vh` above the
 * viewport top (t = 0 is the section's top at the viewport middle).
 */
export function restOffsetVh(t: number, heightVh: number = SCENE_HEIGHT_VH): number {
  return round(t * heightVh - 50, 3)
}

/** CSS `animation-range` for a window slice of a scene's section timeline. */
export function coverRange(t0: number, t1: number, heightVh: number = SCENE_HEIGHT_VH): string {
  return `cover ${round(windowToCover(t0, heightVh))}% cover ${round(windowToCover(t1, heightVh))}%`
}

/**
 * Keyframes that move the pinned stage between the right side (odd
 * scenes: 1, 3, …) and the left side (even scenes), driven by the whole
 * track's view timeline (`cover` range). The track is the hero
 * (`heroVh`) followed by `sceneCount` sections of `sceneVh` each; the
 * stage switches sides while a section boundary passes the middle of the
 * viewport (± `glideVh`). `flip` is the CSS translate of the left side.
 */
export function stageSideKeyframes(name: string, sceneCount: number, flip: string, opts: { heroVh?: number, sceneVh?: number, glideVh?: number } = {}): string {
  const heroVh = opts.heroVh ?? HERO_HEIGHT_VH
  const sceneVh = opts.sceneVh ?? SCENE_HEIGHT_VH
  const glide = opts.glideVh ?? 12
  const trackVh = heroVh + sceneCount * sceneVh
  const pct = (trackY: number) => round(clamp01((trackY + 50) / (trackVh + 100)) * 100, 3)
  const side = (i: number) => (i % 2 === 0 ? '0 0' : `${flip} 0`)
  const stops = [`0% { translate: ${side(0)}; }`]
  for (let i = 1; i < sceneCount; i++) {
    const boundary = heroVh + i * sceneVh
    stops.push(`${pct(boundary - glide)}% { translate: ${side(i - 1)}; }`)
    stops.push(`${pct(boundary + glide)}% { translate: ${side(i)}; }`)
  }
  stops.push(`100% { translate: ${side(sceneCount - 1)}; }`)
  return `@keyframes ${name} { ${stops.join(' ')} }`
}

/**
 * Which frame a looping video shows `elapsedMs` into playback, given its
 * frame count, frame rate and the hold on the last frame — the capture
 * pipeline's timeline.
 */
export function loopFrameAt(elapsedMs: number, frameCount: number, fps: number, holdMs: number): number {
  if (frameCount <= 1 || fps <= 0) return 0
  const playMs = (frameCount / fps) * 1000
  const cycle = playMs + Math.max(0, holdMs)
  const t = ((elapsedMs % cycle) + cycle) % cycle
  return t >= playMs ? frameCount - 1 : Math.min(frameCount - 1, Math.floor((t * fps) / 1000))
}

// ─── Images + video ───────────────────────────────────────────────────

/** `srcset` attribute for an image (the base `src` plus its variants). */
export function srcsetFor(img: TourImage): string {
  const all = [{ src: img.src, width: img.width }, ...(img.srcset ?? [])]
  const seen = new Set<number>()
  return all
    .filter((v) => {
      if (seen.has(v.width)) return false
      seen.add(v.width)
      return true
    })
    .sort((a, b) => a.width - b.width)
    .map(v => `${v.src} ${v.width}w`)
    .join(', ')
}

/** `<source type>` for an encode (codec strings let the browser skip what it can't decode). */
export const VIDEO_TYPES = {
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  h264: 'video/mp4; codecs="avc1.640028"'
} as const
