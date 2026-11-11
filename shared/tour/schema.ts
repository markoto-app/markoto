// Validation of public/tour/manifest.json (zod). Used where the JSON is
// read or written: the server-side load (`./data.ts`), the capture
// pipeline (`scripts/capture-tour.ts`) and the unit tests. Kept apart from
// ./manifest.ts so the browser bundle of the product page never ships zod:
// the page gets the parsed manifest from the SSR payload
// (`app/composables/useTourManifest.ts`).

import { z } from 'zod'
import { TOUR_BEAT_IDS, TOUR_SCENE_IDS } from './manifest'

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
const TourPhoneCutSchema = z.object({
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
