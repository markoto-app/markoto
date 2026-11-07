import manifest from './themeThumbnails.manifest.json'

/**
 * First-page pictures of the built-in theme presets, shown in the
 * new-document design picker. Rendered from each preset's showcase fixture
 * by `make theme-thumbs` (`scripts/render-theme-thumbs.ts`) into
 * `public/theme-thumbs/<id>.webp`; the manifest maps a preset id to the
 * hash of what the picture was rendered from (preset theme + fixture +
 * patch). `tests/unit/themeThumbnails.test.ts` fails when a preset changes
 * without a new picture. The hash doubles as the cache-buster.
 */
const THUMBNAILS: Readonly<Record<string, string>> = manifest

/** URL of a preset's thumbnail, or null when none is rendered (the picker shows a swatch). */
export function themeThumbnailUrl(presetId: string): string | null {
  const hash = THUMBNAILS[presetId]
  return hash ? `/theme-thumbs/${presetId}.webp?v=${hash.slice(0, 10)}` : null
}
