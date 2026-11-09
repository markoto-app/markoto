import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { TEMPLATES } from '../../shared/templates'
import { templateThumbnailUrl } from '../../shared/templates/thumbnails'
import manifest from '../../shared/templates/templateThumbnails.manifest.json'
import { templateThumbnailHash, templateThumbnailSources } from '../../scripts/lib/themeThumbnailHash'

// The new-document dialog shows each template as a picture of its first
// page: its text in its design. They are rendered by `make template-thumbs`;
// these checks keep them from going stale when a template's text, design
// or cover placeholders change.
const recorded: Record<string, string> = manifest
const sources = templateThumbnailSources()

describe('template pictures', () => {
  it.each(TEMPLATES.map(t => t.id))('%s has a sample title, a picture and an up-to-date hash', (id) => {
    const source = sources[id]
    expect(source, `add "${id}" to tests/fixtures/theme-shots/template-thumbs.json`).toBeDefined()
    if (!source) return
    expect(existsSync(resolve(__dirname, `../../public/template-thumbs/${id}.webp`)), `run make template-thumbs IDS=${id}`).toBe(true)
    expect(recorded[id], `template "${id}" (text, design or placeholders) changed: run make template-thumbs IDS=${id}`).toBe(templateThumbnailHash(source))
    expect(templateThumbnailUrl(id)).toMatch(new RegExp(`^/template-thumbs/${id}\\.webp\\?v=[0-9a-f]{10}$`))
  })

  it('has no picture for a template that no longer exists', () => {
    const ids = new Set(TEMPLATES.map(t => t.id))
    expect(Object.keys(recorded).filter(k => !ids.has(k))).toEqual([])
  })
})
