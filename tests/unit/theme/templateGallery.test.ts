import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { THEME_PRESETS } from '../../../shared/utils/theme/themePresets'
import manifest from '../../../shared/utils/theme/templateGallery.manifest.json'
import { galleryHash, gallerySources } from '../../../scripts/lib/themeThumbnailHash'

// The SEO template hub shows a picture of each template's example page.
// They are rendered by `make template-gallery` from the template page's own
// `::try-it` example (or a fixture) in its theme; these checks keep them
// from going stale when the example or the theme changes.
const recorded: Record<string, string> = manifest
const sources = gallerySources()
const hub = readFileSync(resolve(__dirname, '../../../content/marketing/en/templates/index.md'), 'utf8')

describe('template gallery pictures', () => {
  it.each(Object.keys(sources))('%s has a picture rendered from its current example and theme', (id) => {
    const source = sources[id]
    if (!source) return
    expect(THEME_PRESETS.some(p => p.id === source.theme), `${id}: theme ${source.theme} is not a preset`).toBe(true)
    expect(existsSync(resolve(__dirname, `../../../public/templates/${id}.webp`)), `run make template-gallery IDS=${id}`).toBe(true)
    expect(recorded[id], `${id}: its example or theme changed — run make template-gallery IDS=${id}`).toBe(galleryHash(source))
  })

  it('every picture the template hub shows has a gallery source', () => {
    const images = [...hub.matchAll(/image: \/templates\/([a-z0-9-]+)\.webp/g)].map(m => m[1])
    expect(images.length).toBeGreaterThan(0)
    for (const id of images) expect(Object.keys(sources)).toContain(id)
  })
})
