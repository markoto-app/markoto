#!/usr/bin/env bun
/**
 * Design-picker thumbnails: the first page of every built-in theme preset,
 * rendered from its showcase fixture (`tests/fixtures/theme-shots/thumbnails.json`)
 * through the real preview with `scripts/render-theme-shots.ts`, scaled to
 * 360 px and saved as `public/theme-thumbs/<id>.webp`. Records what each
 * picture was rendered from in `shared/utils/themeThumbnails.manifest.json`
 * (`tests/unit/themeThumbnails.test.ts` fails when a preset changes without
 * a new picture). `make theme-thumbs`.
 *
 *   bun scripts/render-theme-thumbs.ts --base http://127.0.0.1:3309 [preset …]
 *
 * Needs what render-theme-shots needs with `--patch`: a TEST_MODE=1 app with
 * NUXT_ANON_GATE_ENABLED=false (see docs/TEMPLATE-WORKFLOW.md), plus
 * ImageMagick (`magick`) with WebP support.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { THEME_PRESETS } from '../shared/utils/themePresets'
import { FIXTURE_DIR, thumbnailHash, thumbnailSources } from './lib/themeThumbnailHash'

const ROOT = resolve(import.meta.dirname, '..')
const MANIFEST = resolve(ROOT, 'shared/utils/themeThumbnails.manifest.json')
const OUT_DIR = resolve(ROOT, 'public/theme-thumbs')

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} … exited with ${res.status}`)
}

const argv = process.argv.slice(2)
const baseIdx = argv.indexOf('--base')
const base = baseIdx >= 0 ? argv[baseIdx + 1] : undefined
if (!base) {
  console.error('usage: render-theme-thumbs.ts --base <url> [preset …]')
  process.exit(2)
}
const requested = argv.filter((_, i) => i !== baseIdx && i !== baseIdx + 1)
const ids = requested.length ? requested : THEME_PRESETS.map(p => p.id)

const sources = thumbnailSources()
const manifestRaw: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const manifest: Record<string, string> = {}
if (typeof manifestRaw === 'object' && manifestRaw !== null) {
  for (const [k, v] of Object.entries(manifestRaw)) if (typeof v === 'string') manifest[k] = v
}

const work = mkdtempSync(join(tmpdir(), 'theme-thumbs-'))
try {
  for (const id of ids) {
    const source = sources[id]
    if (!source) throw new Error(`no showcase fixture for preset "${id}" in tests/fixtures/theme-shots/thumbnails.json`)
    const out = join(work, id)
    run('bun', [
      resolve(ROOT, 'scripts/render-theme-shots.ts'),
      '--base', base, '--out', out,
      '--md', resolve(FIXTURE_DIR, source.md),
      '--title', source.title,
      ...(source.patch ? ['--patch', resolve(FIXTURE_DIR, source.patch)] : []),
      id
    ])
    run('magick', [join(out, `${id}-p1.png`), '-resize', '360x', '-strip', '-quality', '82', join(OUT_DIR, `${id}.webp`)])
    manifest[id] = thumbnailHash(id, source)
    console.log(`${id}: public/theme-thumbs/${id}.webp`)
  }
  // Drop pictures of presets that no longer exist from the manifest.
  const known = new Set(THEME_PRESETS.map(p => p.id))
  const sorted = Object.fromEntries(Object.entries(manifest).filter(([k]) => known.has(k)).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
