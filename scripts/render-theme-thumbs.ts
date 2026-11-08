#!/usr/bin/env bun
/**
 * Two picture sets, both rendered through the real preview so they never
 * drift from the product:
 *
 * - default: design-picker thumbnails — the first page of every built-in theme preset,
 * rendered from its showcase fixture (`tests/fixtures/theme-shots/thumbnails.json`)
 * through the real preview with `scripts/render-theme-shots.ts`, scaled to
 * 360 px and saved as `public/theme-thumbs/<id>.webp`. Records what each
 * picture was rendered from in `shared/utils/themeThumbnails.manifest.json`
 * (`tests/unit/themeThumbnails.test.ts` fails when a preset changes without
 * a new picture). `make theme-thumbs`.
 * - `--gallery`: the template-gallery pictures of the SEO template pages,
 *   `public/templates/<id>.webp` (600 px), from
 *   `tests/fixtures/theme-shots/template-gallery.json` (a page's `::try-it`
 *   example or a fixture, in its theme), hashes in
 *   `shared/utils/templateGallery.manifest.json`
 *   (`tests/unit/templateGallery.test.ts`). `make template-gallery`.
 *
 *   bun scripts/render-theme-thumbs.ts --base http://127.0.0.1:3309 [--gallery] [id …]
 *
 * Needs what render-theme-shots needs with `--patch`: a TEST_MODE=1 app with
 * NUXT_ANON_GATE_ENABLED=false (see docs/TEMPLATE-WORKFLOW.md), plus
 * ImageMagick (`magick`) with WebP support.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { THEME_PRESETS } from '../shared/utils/themePresets'
import { FIXTURE_DIR, galleryHash, gallerySources, thumbnailHash, thumbnailSources } from './lib/themeThumbnailHash'

const ROOT = resolve(import.meta.dirname, '..')
const GALLERY = process.argv.includes('--gallery')
const MANIFEST = resolve(ROOT, GALLERY ? 'shared/utils/templateGallery.manifest.json' : 'shared/utils/themeThumbnails.manifest.json')
const OUT_DIR = resolve(ROOT, GALLERY ? 'public/templates' : 'public/theme-thumbs')
const WIDTH = GALLERY ? 600 : 360

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} … exited with ${res.status}`)
}

const argv = process.argv.slice(2)
const baseIdx = argv.indexOf('--base')
const base = baseIdx >= 0 ? argv[baseIdx + 1] : undefined
if (!base) {
  console.error('usage: render-theme-thumbs.ts --base <url> [--gallery] [id …]')
  process.exit(2)
}
const requested = argv.filter((a, i) => i !== baseIdx && i !== baseIdx + 1 && a !== '--gallery')
const galleries = GALLERY ? gallerySources() : {}
const ids = requested.length ? requested : GALLERY ? Object.keys(galleries) : THEME_PRESETS.map(p => p.id)

const sources = GALLERY ? {} : thumbnailSources()
const manifestRaw: unknown = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
const manifest: Record<string, string> = {}
if (typeof manifestRaw === 'object' && manifestRaw !== null) {
  for (const [k, v] of Object.entries(manifestRaw)) if (typeof v === 'string') manifest[k] = v
}

const work = mkdtempSync(join(tmpdir(), 'theme-thumbs-'))
try {
  for (const id of ids) {
    const out = join(work, id)
    let shotArgs: string[]
    let preset: string
    let page = 1
    let hash: string
    if (GALLERY) {
      const g = galleries[id]
      if (!g) throw new Error(`no gallery source for "${id}" in tests/fixtures/theme-shots/template-gallery.json`)
      const md = join(work, `${id}.md`)
      writeFileSync(md, g.md)
      shotArgs = ['--md', md, '--title', g.title]
      preset = g.theme
      page = g.pageNumber
      hash = galleryHash(g)
    } else {
      const source = sources[id]
      if (!source) throw new Error(`no showcase fixture for preset "${id}" in tests/fixtures/theme-shots/thumbnails.json`)
      shotArgs = [
        '--md', resolve(FIXTURE_DIR, source.md), '--title', source.title,
        ...(source.patch ? ['--patch', resolve(FIXTURE_DIR, source.patch)] : [])
      ]
      preset = id
      hash = thumbnailHash(id, source)
    }
    run('bun', [resolve(ROOT, 'scripts/render-theme-shots.ts'), '--base', base, '--out', out, ...shotArgs, preset])
    run('magick', [join(out, `${preset}-p${page}.png`), '-resize', `${WIDTH}x`, '-strip', '-quality', '82', join(OUT_DIR, `${id}.webp`)])
    manifest[id] = hash
    console.log(`${id}: ${OUT_DIR.slice(ROOT.length + 1)}/${id}.webp`)
  }
  // Drop pictures whose source no longer exists from the manifest.
  const known = new Set(GALLERY ? Object.keys(galleries) : THEME_PRESETS.map(p => p.id))
  const sorted = Object.fromEntries(Object.entries(manifest).filter(([k]) => known.has(k)).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
