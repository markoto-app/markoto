import manifest from './templateThumbnails.manifest.json'

/**
 * Pictures of the templates in the new-document dialog: the first page of
 * each template's text in its design, rendered by `make template-thumbs`
 * (`scripts/render-theme-thumbs.ts --templates`) into
 * `public/template-thumbs/<id>.webp`. The manifest maps a template id to
 * the hash of what the picture was rendered from;
 * `tests/unit/templateThumbnails.test.ts` fails when it is stale. The hash
 * doubles as the cache-buster.
 */
const THUMBNAILS: Readonly<Record<string, string>> = manifest

/** URL of a template's picture, or null when none is rendered. */
export function templateThumbnailUrl(templateId: string): string | null {
  const hash = THUMBNAILS[templateId]
  return hash ? `/template-thumbs/${templateId}.webp?v=${hash.slice(0, 10)}` : null
}
