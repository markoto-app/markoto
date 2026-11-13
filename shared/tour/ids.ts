// Scene and beat ids of the product tour. A leaf: the manifest helpers
// (`./manifest.ts`) and the zod schema (`./schema.ts`) both need them, and
// the manifest takes its types from the schema.

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
