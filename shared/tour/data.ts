// The product tour's manifest, validated once at module load. The JSON
// lives next to the assets it describes (`public/tour/`), where
// `scripts/capture-tour.ts` writes both; importing it (instead of
// fetching `/tour/manifest.json`) puts the data in the SSR bundle, so the
// page renders its first still with no extra request.

import raw from '../../public/tour/manifest.json'
import { parseTourManifest, type TourManifest } from './schema'

export const tourManifest: TourManifest = parseTourManifest(raw)
