import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEME_PRESETS } from '../../shared/utils/themePresets'

/**
 * What a preset's design-picker thumbnail is rendered from: the preset
 * theme plus its showcase fixture (Markdown, title, optional patch) from
 * `tests/fixtures/theme-shots/thumbnails.json`. Shared by
 * `scripts/render-theme-thumbs.ts` (writes the hash into
 * `shared/utils/themeThumbnails.manifest.json`) and `tests/unit/themeThumbnails.test.ts`
 * (fails when a preset or its fixture changed without a new picture).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FIXTURE_DIR = resolve(ROOT, 'tests/fixtures/theme-shots')

export interface ThumbnailSource { md: string, title: string, patch?: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function thumbnailSources(): Record<string, ThumbnailSource> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'thumbnails.json'), 'utf8'))
  if (!isRecord(parsed)) throw new Error('thumbnails.json must hold an object')
  const out: Record<string, ThumbnailSource> = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value)) throw new Error(`thumbnails.json: ${id} must be an object`)
    const { md, title, patch } = value
    if (typeof md !== 'string' || typeof title !== 'string' || (patch !== undefined && typeof patch !== 'string')) {
      throw new Error(`thumbnails.json: ${id} needs "md" and "title" strings (and an optional "patch")`)
    }
    out[id] = patch === undefined ? { md, title } : { md, title, patch }
  }
  return out
}

export function thumbnailHash(presetId: string, source: ThumbnailSource): string {
  const preset = THEME_PRESETS.find(p => p.id === presetId)
  if (!preset) throw new Error(`unknown preset ${presetId}`)
  const h = createHash('sha256')
  h.update(JSON.stringify(preset.theme))
  h.update('\0')
  h.update(readFileSync(resolve(FIXTURE_DIR, source.md)))
  h.update('\0')
  h.update(source.title)
  h.update('\0')
  if (source.patch) h.update(readFileSync(resolve(FIXTURE_DIR, source.patch)))
  return h.digest('hex')
}
