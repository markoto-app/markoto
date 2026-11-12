import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { THEME_PRESETS } from '../../shared/utils/theme/themePresets'
import { showsTitleItself, withoutTitleHeading } from '../../shared/utils/markdown/markdownTitle'
import { TEMPLATES, templateCover } from '../../shared/templates'

/**
 * What a preset's design-picker thumbnail is rendered from: the preset
 * theme plus its showcase fixture (Markdown, title, optional patch) from
 * `tests/fixtures/theme-shots/thumbnails.json`. Shared by
 * `scripts/render-theme-thumbs.ts` (writes the hash into
 * `shared/utils/theme/themeThumbnails.manifest.json`) and `tests/unit/theme/themeThumbnails.test.ts`
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

/**
 * The template-gallery pictures on the SEO template pages
 * (`public/templates/<id>.webp`, `::template-cards` in
 * content/marketing/en/templates/index.md): one page of the template's
 * example, rendered in its theme. A source is either a fixture file with a
 * title and preset, or a marketing page whose first `::try-it` block
 * (theme + source) is the example, so editing the page's example or the
 * preset makes the picture stale (`tests/unit/theme/templateGallery.test.ts`).
 */
export interface GallerySource { md: string, title: string, theme: string, pageNumber: number }

export function gallerySources(): Record<string, GallerySource> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'template-gallery.json'), 'utf8'))
  if (!isRecord(parsed)) throw new Error('template-gallery.json must hold an object')
  const out: Record<string, GallerySource> = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value)) throw new Error(`template-gallery.json: ${id} must be an object`)
    const pageNumber = typeof value.pageNumber === 'number' ? value.pageNumber : 1
    if (typeof value.tryIt === 'string') {
      const { theme, source } = firstTryIt(resolve(FIXTURE_DIR, value.tryIt))
      const title = /^#[ \t]+(\S[^\n]*)$/m.exec(source)?.[1]?.trim() ?? id
      // Same as the page's workbench: a title-block theme sets the title
      // itself, so the example's leading `# Title` stays out of the body.
      const cover = THEME_PRESETS.find(p => p.id === theme)?.theme.cover
      const md = cover && showsTitleItself(cover) ? withoutTitleHeading(source) : source
      out[id] = { md, title, theme, pageNumber }
    } else if (typeof value.md === 'string' && typeof value.title === 'string' && typeof value.theme === 'string') {
      out[id] = { md: readFileSync(resolve(FIXTURE_DIR, value.md), 'utf8'), title: value.title, theme: value.theme, pageNumber }
    } else {
      throw new Error(`template-gallery.json: ${id} needs "tryIt", or "md" + "title" + "theme"`)
    }
  }
  return out
}

/** Theme + Markdown of the first `::try-it{theme="…"}` block of a content page. */
function firstTryIt(file: string): { theme: string, source: string } {
  const text = readFileSync(file, 'utf8')
  const m = /^::try-it\{([^}]*)\}\n---\n([\s\S]*?)\n---\n/m.exec(text)
  if (!m) throw new Error(`${file}: no ::try-it block with YAML props`)
  const theme = /theme="([^"]+)"/.exec(m[1] ?? '')?.[1]
  const props: unknown = parseYaml(m[2] ?? '')
  const source = isRecord(props) && typeof props.source === 'string' ? props.source : undefined
  if (!theme || !source) throw new Error(`${file}: the ::try-it block needs theme="…" and a source`)
  return { theme, source }
}

export function galleryHash(source: GallerySource): string {
  const preset = THEME_PRESETS.find(p => p.id === source.theme)
  if (!preset) throw new Error(`unknown preset ${source.theme}`)
  const h = createHash('sha256')
  h.update(JSON.stringify(preset.theme))
  h.update('\0')
  h.update(source.md)
  h.update('\0')
  h.update(source.title)
  h.update('\0')
  h.update(String(source.pageNumber))
  return h.digest('hex')
}

/**
 * The new-document dialog's template pictures
 * (`public/template-thumbs/<id>.webp`): the first page of each template's
 * English text in its design, with its cover placeholders and a sample
 * title (and optional `pageNumber`) from
 * `tests/fixtures/theme-shots/template-thumbs.json`. Blank
 * shows the markoto design (the default when the workspace sets none).
 * `tests/unit/theme/templateThumbnails.test.ts` fails when the text, the
 * design or the placeholders changed without a new picture.
 */
export interface TemplateThumbnailSource {
  md: string
  title: string
  theme: string
  /** Page the picture shows: 1, or the first content page where the cover
   *  (and contents) would look like another template's (Demo, Report,
   *  Business plan). */
  pageNumber: number
  /** Theme patch (the template's cover placeholders), or null. */
  patch: Record<string, unknown> | null
}

export function templateThumbnailSources(): Record<string, TemplateThumbnailSource> {
  const titles: unknown = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'template-thumbs.json'), 'utf8'))
  if (!isRecord(titles)) throw new Error('template-thumbs.json must hold an object')
  const out: Record<string, TemplateThumbnailSource> = {}
  for (const tpl of TEMPLATES) {
    const entry = thumbnailEntry(titles[tpl.id])
    if (entry === null) continue
    const { title, pageNumber } = entry
    const body = tpl.hasContent ? readFileSync(resolve(ROOT, 'shared/templates/content', tpl.content, 'en.md'), 'utf8') : ''
    const md = body.replaceAll('{{title}}', title).replaceAll('{{description}}', '')
    const cover = templateCover(tpl, 'en')
    out[tpl.id] = { md, title, theme: tpl.design ?? 'markoto', pageNumber, patch: cover ? { cover } : null }
  }
  return out
}

/** A template's entry of template-thumbs.json: "<title>" or { "title": "<title>", "pageNumber": 2 }; null without a title. */
function thumbnailEntry(entry: unknown): { title: string, pageNumber: number } | null {
  if (typeof entry === 'string') return { title: entry, pageNumber: 1 }
  if (!isRecord(entry) || typeof entry.title !== 'string') return null
  return { title: entry.title, pageNumber: typeof entry.pageNumber === 'number' ? entry.pageNumber : 1 }
}

export function templateThumbnailHash(source: TemplateThumbnailSource): string {
  const preset = THEME_PRESETS.find(p => p.id === source.theme)
  if (!preset) throw new Error(`unknown preset ${source.theme}`)
  const h = createHash('sha256')
  h.update(JSON.stringify(preset.theme))
  h.update('\0')
  h.update(source.md)
  h.update('\0')
  h.update(source.title)
  h.update('\0')
  h.update(JSON.stringify(source.patch))
  h.update('\0')
  h.update(String(source.pageNumber))
  return h.digest('hex')
}
