// Product tour: the asset contract between the capture pipeline
// (`scripts/capture-tour.ts` + `tests/e2e/tour/*.capture.ts`) and the
// scroll-driven product page (`app/components/landing/ProductTour.vue`).
//
// `public/tour/manifest.json` describes, per scene: a poster still (light
// + dark, `srcset` widths) and a short looping video (AV1 + H.264, light +
// dark), each also in a phone cut, the region of the capture that
// matters, cropped and encoded small. Videos are recorded step by step
// from the real app with a virtual cursor baked in; the page only plays
// them while their scene is on stage.
//
// The scroll choreography is CSS (`animation-range` on view timelines);
// the helpers below compute those ranges and the generated keyframes for
// the stage that alternates sides. All pure, so the page and the unit
// tests (`tests/unit/seo/tourManifest.test.ts`) share them.

// The zod schema + parser live in ./schema.ts so the page bundle (which
// only needs these helpers and the types) never ships zod.
import type { TourImage } from './schema'

export type { TourBeat, TourImage, TourManifest, TourScene, TourVideo } from './schema'
export { TOUR_BEAT_IDS, TOUR_SCENE_IDS, type TourBeatId, type TourSceneId } from './ids'

// Scroll math

/** Scroll length of each scene section, in viewport heights. */
export const SCENE_HEIGHT_VH = 160
/** Height of the hero inside the pinned layout, in viewport heights. */
const HERO_HEIGHT_VH = 100

function clamp01(n: number): number {
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
 * window at `t`: i.e. the section's top is `t·height − 50vh` above the
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
 * frame count, frame rate and the hold on the last frame, the capture
 * pipeline's timeline.
 */
export function loopFrameAt(elapsedMs: number, frameCount: number, fps: number, holdMs: number): number {
  if (frameCount <= 1 || fps <= 0) return 0
  const playMs = (frameCount / fps) * 1000
  const cycle = playMs + Math.max(0, holdMs)
  const t = ((elapsedMs % cycle) + cycle) % cycle
  return t >= playMs ? frameCount - 1 : Math.min(frameCount - 1, Math.floor((t * fps) / 1000))
}

// Images + video

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
