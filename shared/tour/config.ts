// Product tour (WP11) settings that are design decisions, not assets.

import type { TourSceneId } from './manifest'

/**
 * The page starts light and turns dark while this scene comes in: the
 * self-hosting scene, where the page "gets nerdy". Every scene before it
 * uses its light video; this scene loads both for the cross-fade; the
 * closing call to action and the footer are dark too. Move it to shift
 * the flip (any scene id from `TOUR_SCENE_IDS`).
 */
export const TOUR_DARK_FROM: TourSceneId = 'yours'
