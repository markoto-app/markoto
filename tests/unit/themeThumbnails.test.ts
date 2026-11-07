import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { themeThumbnailUrl } from '../../shared/utils/themeThumbnails'
import manifest from '../../shared/utils/themeThumbnails.manifest.json'
import { thumbnailHash, thumbnailSources } from '../../scripts/lib/themeThumbnailHash'

// The new-document design picker shows a picture of each preset's first
// page. They are rendered by `make theme-thumbs`; these checks keep them
// from going stale when a preset (or its showcase fixture) changes.
const recorded: Record<string, string> = manifest
const sources = thumbnailSources()

describe('theme preset thumbnails', () => {
  it.each(THEME_PRESETS.map(p => p.id))('%s has a showcase fixture, a picture and an up-to-date hash', (id) => {
    const source = sources[id]
    expect(source, `add "${id}" to tests/fixtures/theme-shots/thumbnails.json`).toBeDefined()
    if (!source) return
    expect(existsSync(resolve(__dirname, `../../public/theme-thumbs/${id}.webp`)), `run make theme-thumbs PRESETS=${id}`).toBe(true)
    expect(recorded[id], `preset "${id}" or its fixture changed: run make theme-thumbs PRESETS=${id}`).toBe(thumbnailHash(id, source))
    expect(themeThumbnailUrl(id)).toMatch(new RegExp(`^/theme-thumbs/${id}\\.webp\\?v=[0-9a-f]{10}$`))
  })

  it('has no picture for a preset that no longer exists', () => {
    const ids = new Set(THEME_PRESETS.map(p => p.id))
    expect(Object.keys(recorded).filter(k => !ids.has(k))).toEqual([])
  })

  it('every preset has an audience category', () => {
    for (const p of THEME_PRESETS) expect(['general', 'engineering', 'academic', 'business', 'writing']).toContain(p.category)
  })
})
