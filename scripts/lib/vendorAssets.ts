// Build-time generator for the same-origin browser assets served under
// `/vendor/` (see shared/utils/vendor/vendorAssets.ts for the why). Used by
// modules/vendor-assets.ts (every `nuxt build` / `nuxt dev`) and by
// tests/unit/rendering/vendorAssets.test.ts.
//
// Sources are the pinned npm packages in node_modules; nothing is
// downloaded. The versions + SRI hashes the app's runtime code uses live
// in shared/utils/vendor/*Assets.ts — `checkVendorPackages` fails the build when
// the installed packages differ from them.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PAGEDJS_POLYFILL_SRI, PAGEDJS_POLYFILL_URL, PAGEDJS_VERSION } from '../../shared/utils/vendor/pagedjsAssets'
import { MERMAID_SRI, MERMAID_URL, MERMAID_VERSION } from '../../shared/utils/vendor/mermaidAssets'
import { KATEX_CSS_SRI, KATEX_CSS_URL, KATEX_VERSION } from '../../shared/utils/vendor/katexAssets'
import { HLJS_STYLES_BASE, HLJS_THEMES, HLJS_VERSION } from '../../shared/utils/vendor/hljsAssets'
import { BUNDLED_FONTS_DIR, FONT_STYLESHEET_BASE, SELF_HOSTED_FONTS, uiFontFamilyName, uiFontStylesheetName, type FontsourceSource, type SelfHostedFont } from '../../shared/utils/theme/themeFonts'
import { VENDOR_BASE } from '../../shared/utils/vendor/vendorAssets'

/** One file copied from an npm package to `/vendor/…`. */
export interface VendorFile {
  package: string
  /** Path inside the package directory. */
  from: string
  /** Public URL (starts with VENDOR_BASE). */
  url: string
  /** Pinned SRI hash the bytes must match (scripts + stylesheets loaded with `integrity`). */
  sri?: string
}

/** Package versions the runtime constants were written for. */
export const PINNED_VERSIONS: Readonly<Record<string, string>> = {
  'pagedjs': PAGEDJS_VERSION,
  'mermaid': MERMAID_VERSION,
  'katex': KATEX_VERSION,
  'highlight.js': HLJS_VERSION
}

/** The SRI-locked scripts + stylesheets. */
export function lockedVendorFiles(): VendorFile[] {
  return [
    { package: 'pagedjs', from: 'dist/paged.polyfill.min.js', url: PAGEDJS_POLYFILL_URL, sri: PAGEDJS_POLYFILL_SRI },
    { package: 'mermaid', from: 'dist/mermaid.min.js', url: MERMAID_URL, sri: MERMAID_SRI },
    { package: 'katex', from: 'dist/katex.min.css', url: KATEX_CSS_URL, sri: KATEX_CSS_SRI },
    ...Object.values(HLJS_THEMES).map(t => ({
      package: 'highlight.js',
      from: `styles/${t.path}.min.css`,
      url: `${HLJS_STYLES_BASE}${t.path}.min.css`,
      sri: t.sri
    }))
  ]
}

/** `sha384-…` of a byte buffer (the SRI format). */
export function sriOf(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`
}

function packageDir(rootDir: string, pkg: string): string {
  return join(rootDir, 'node_modules', pkg)
}

/** Installed version of `pkg`, or null when it isn't installed. */
export function installedVersion(rootDir: string, pkg: string): string | null {
  const file = join(packageDir(rootDir, pkg), 'package.json')
  if (!existsSync(file)) return null
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return null
  const version = (parsed as Record<string, unknown>).version
  return typeof version === 'string' ? version : null
}

/** Licence file of a package (first match), relative to its directory. */
function licenceFile(rootDir: string, pkg: string): string | null {
  const dir = packageDir(rootDir, pkg)
  return readdirSync(dir).find(f => /^licen[cs]e(\.(md|txt))?$/i.test(f)) ?? null
}

/** Every reason the installed packages can't produce the pinned assets (empty = fine). */
export function checkVendorPackages(rootDir: string): string[] {
  const problems: string[] = []
  for (const [pkg, version] of Object.entries(PINNED_VERSIONS)) {
    const installed = installedVersion(rootDir, pkg)
    if (installed !== version) {
      problems.push(`${pkg}: shared/utils pins ${version}, node_modules has ${installed ?? 'nothing'} — bump package.json and the *Assets.ts constant together`)
    }
  }
  for (const file of lockedVendorFiles()) {
    const path = join(packageDir(rootDir, file.package), file.from)
    if (!existsSync(path)) {
      problems.push(`${file.package}: ${file.from} is missing`)
      continue
    }
    const actual = sriOf(readFileSync(path))
    if (file.sri && actual !== file.sri) {
      problems.push(`${file.package}/${file.from}: SRI is ${actual}, the pinned constant says ${file.sri}`)
    }
  }
  const checkFontsource = (font: SelfHostedFont, source: FontsourceSource) => {
    if (installedVersion(rootDir, source.package) === null) {
      problems.push(`${font.name}: ${source.package} is not installed`)
      return
    }
    for (const sheet of source.stylesheets) {
      if (!existsSync(join(packageDir(rootDir, source.package), sheet))) {
        problems.push(`${font.name}: ${source.package}/${sheet} is missing`)
      }
    }
  }
  for (const font of SELF_HOSTED_FONTS) {
    const source = font.source
    if (font.ui) checkFontsource(font, font.ui)
    if (source.kind === 'bundled') {
      const dir = bundledFontDir(rootDir, font)
      for (const face of source.faces) {
        if (!existsSync(join(dir, face.file))) problems.push(`${font.name}: ${BUNDLED_FONTS_DIR}/${font.slug}/${face.file} is missing`)
        if (face.licence && !existsSync(join(dir, face.licence))) problems.push(`${font.name}: ${BUNDLED_FONTS_DIR}/${font.slug}/${face.licence} is missing`)
      }
      if (!existsSync(join(dir, 'LICENSE.txt'))) problems.push(`${font.name}: ${BUNDLED_FONTS_DIR}/${font.slug}/LICENSE.txt is missing`)
      continue
    }
    checkFontsource(font, source)
  }
  return problems
}

/** Repo folder with a bundled family's woff2 files + licence. */
export function bundledFontDir(rootDir: string, font: SelfHostedFont): string {
  return join(rootDir, BUNDLED_FONTS_DIR, font.slug)
}

/** Licence files next to a family's files (the bundled families' companion files bring their own). */
function fontLicences(font: SelfHostedFont, variant: 'document' | 'ui'): string[] {
  const source = font.source
  if (variant === 'ui' || source.kind !== 'bundled') return ['LICENSE.txt']
  return [...new Set(['LICENSE.txt', ...source.faces.flatMap(f => f.licence ? [f.licence] : [])])]
}

/** Where a family's files come from, for the stylesheet's header comment. */
function fontOrigin(font: SelfHostedFont, version: string): string {
  return font.source.kind === 'bundled' ? `${BUNDLED_FONTS_DIR}/${font.slug} (v${version})` : `${font.source.package}@${version}`
}

// — fonts ————————————————————————————————————————————————————————————

/** One @font-face rule of a Fontsource stylesheet, reduced to what we emit. */
export interface FontFace {
  style: string
  weight: string
  unicodeRange: string
  /** woff2 file name inside the package's `files/`. */
  file: string
}

function descriptor(block: string, name: string): string | null {
  const m = new RegExp(String.raw`(?:^|[;{\s])${name}\s*:\s*([^;]+);`).exec(block)
  return m?.[1]?.trim() ?? null
}

/** The @font-face rules of a Fontsource stylesheet (woff2 sources only). */
export function parseFontsourceCss(css: string): FontFace[] {
  const faces: FontFace[] = []
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = match[1] ?? ''
    const file = /url\(\.\/files\/([\w.-]+\.woff2)\)/.exec(block)?.[1]
    const style = descriptor(block, 'font-style')
    const weight = descriptor(block, 'font-weight')
    const unicodeRange = descriptor(block, 'unicode-range')
    if (!file || !style || !weight || !unicodeRange) {
      throw new Error(`unexpected @font-face rule in Fontsource stylesheet: ${block.trim().slice(0, 200)}`)
    }
    faces.push({ style, weight, unicodeRange, file })
  }
  return faces
}

/** Directory (relative to the stylesheet) holding a family's files: `<slug>@<version>` (`<slug>-variable@<version>` for the app-shell cut). */
export function fontFilesDir(font: SelfHostedFont, version: string, variant: 'document' | 'ui' = 'document'): string {
  return variant === 'ui' ? `${font.slug}-variable@${version}` : `${font.slug}@${version}`
}

/** The family's stylesheet: one @font-face per subset / style (/ weight), named as the theme names it. */
export function buildFontCss(font: SelfHostedFont, version: string, faces: readonly FontFace[], variant: 'document' | 'ui' = 'document'): string {
  const family = (variant === 'ui' ? uiFontFamilyName(font) : font.name).replaceAll('\\', '').replaceAll('\'', '')
  const dir = fontFilesDir(font, version, variant)
  const rules = faces.map(face => [
    '@font-face {',
    `  font-family: '${family}';`,
    `  font-style: ${face.style};`,
    // Same behaviour as the Google Fonts `display=swap` URLs this replaced.
    '  font-display: swap;',
    `  font-weight: ${face.weight};`,
    `  src: url('${dir}/${face.file}') format('woff2');`,
    `  unicode-range: ${face.unicodeRange};`,
    '}'
  ].join('\n'))
  return [
    `/* ${font.name} — ${variant === 'ui' && font.ui ? `${font.ui.package}@${version}` : fontOrigin(font, version)}, licence: ${fontLicences(font, variant).map(l => `${dir}/${l}`).join(', ')}. Generated by modules/vendor-assets.ts. */`,
    ...rules
  ].join('\n') + '\n'
}

// — generation ———————————————————————————————————————————————————————

export interface GeneratedSummary {
  files: number
  bytes: number
  /** Font bytes per family (woff2 only). */
  fontBytes: Record<string, number>
}

function copy(from: string, to: string): number {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  return statSync(to).size
}

function vendorPath(outDir: string, url: string): string {
  if (!url.startsWith(VENDOR_BASE)) throw new Error(`not a vendor URL: ${url}`)
  return join(outDir, url.slice(VENDOR_BASE.length))
}

/** Bump when the generator's output format changes, so stale build dirs are rebuilt. */
const GENERATOR_REVISION = 4

/** Fingerprint of everything the output depends on (package versions + pinned constants + font registry). */
export function vendorInputsKey(rootDir: string): string {
  const packages = [
    ...Object.keys(PINNED_VERSIONS),
    ...SELF_HOSTED_FONTS.flatMap(f => [...(f.source.kind === 'fontsource' ? [f.source.package] : []), ...(f.ui ? [f.ui.package] : [])])
  ]
  const parts = {
    versions: packages.map(p => `${p}@${installedVersion(rootDir, p) ?? '-'}`),
    files: lockedVendorFiles(),
    fonts: SELF_HOSTED_FONTS,
    // Bundled font files live in the repo, not in a versioned package.
    bundled: SELF_HOSTED_FONTS.flatMap(f => f.source.kind === 'bundled'
      ? f.source.faces.map((face) => {
          const path = join(bundledFontDir(rootDir, f), face.file)
          return existsSync(path) ? sriOf(readFileSync(path)) : '-'
        })
      : []),
    generator: GENERATOR_REVISION
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * Write every vendored asset into `outDir` (served at VENDOR_BASE).
 * Throws with every problem when the installed packages don't match the
 * pinned constants. Writes into a temp dir and swaps it in, so a
 * half-written tree is never served.
 */
export function generateVendorAssets(rootDir: string, outDir: string): GeneratedSummary {
  const problems = checkVendorPackages(rootDir)
  if (problems.length > 0) {
    throw new Error(`[vendor-assets] the installed packages don't match the pinned assets:\n  - ${problems.join('\n  - ')}`)
  }
  const tmp = `${outDir}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  const summary: GeneratedSummary = { files: 0, bytes: 0, fontBytes: {} }
  const add = (bytes: number) => {
    summary.files += 1
    summary.bytes += bytes
  }

  // Scripts + stylesheets (unmodified bytes — the SRI hashes are of these).
  for (const file of lockedVendorFiles()) {
    add(copy(join(packageDir(rootDir, file.package), file.from), vendorPath(tmp, file.url)))
  }
  // KaTeX's stylesheet loads `fonts/KaTeX_*.woff2` relative to itself
  // (woff / ttf are listed as fallbacks only; every browser we support
  // takes the woff2 first, so they're not shipped).
  const katexFonts = join(packageDir(rootDir, 'katex'), 'dist', 'fonts')
  const katexOut = dirname(vendorPath(tmp, KATEX_CSS_URL))
  for (const f of readdirSync(katexFonts).filter(f => f.endsWith('.woff2'))) {
    add(copy(join(katexFonts, f), join(katexOut, 'fonts', f)))
  }
  // Licences next to each package's files.
  for (const [pkg, version] of Object.entries(PINNED_VERSIONS)) {
    const licence = licenceFile(rootDir, pkg)
    if (licence) add(copy(join(packageDir(rootDir, pkg), licence), join(tmp, `${pkg}@${version}`, 'LICENSE.txt')))
  }

  // Fonts: one stylesheet per family + its woff2 files + licence(s).
  const fontsOut = vendorPath(tmp, FONT_STYLESHEET_BASE)
  mkdirSync(fontsOut, { recursive: true })
  const writeFamily = (font: SelfHostedFont, version: string, filesDir: string, faces: readonly FontFace[], licences: ReadonlyArray<[from: string, to: string]>, variant: 'document' | 'ui', sheetName: string) => {
    const dir = join(fontsOut, fontFilesDir(font, version, variant))
    let familyBytes = 0
    for (const face of faces) {
      const bytes = copy(join(filesDir, face.file), join(dir, face.file))
      familyBytes += bytes
      add(bytes)
    }
    for (const [from, to] of licences) add(copy(from, join(dir, to)))
    const css = buildFontCss(font, version, faces, variant)
    writeFileSync(join(fontsOut, sheetName), css)
    add(Buffer.byteLength(css))
    return familyBytes
  }
  const fontsourceFamily = (font: SelfHostedFont, source: FontsourceSource, variant: 'document' | 'ui', sheetName: string) => {
    const pkgDir = packageDir(rootDir, source.package)
    const faces = source.stylesheets.flatMap(sheet => parseFontsourceCss(readFileSync(join(pkgDir, sheet), 'utf8')))
    const licence = licenceFile(rootDir, source.package)
    return writeFamily(font, installedVersion(rootDir, source.package) ?? '', join(pkgDir, 'files'), faces, licence ? [[join(pkgDir, licence), 'LICENSE.txt']] : [], variant, sheetName)
  }
  for (const font of SELF_HOSTED_FONTS) {
    const source = font.source
    if (source.kind === 'bundled') {
      // Bundled families: files committed in fonts/<slug>/, one woff2 per
      // style (+ companion files for another script, with their own range
      // and licence).
      const filesDir = bundledFontDir(rootDir, font)
      const faces = source.faces.map(f => ({ style: f.style, weight: String(f.weight), unicodeRange: f.unicodeRange ?? source.unicodeRange, file: f.file }))
      const licences = fontLicences(font, 'document').map((l): [string, string] => [join(filesDir, l), l])
      summary.fontBytes[font.name] = writeFamily(font, source.version, filesDir, faces, licences, 'document', `${font.slug}.css`)
    } else {
      summary.fontBytes[font.name] = fontsourceFamily(font, source, 'document', `${font.slug}.css`)
    }
    // The app shell's variable cut, next to the document stylesheet.
    if (font.ui) fontsourceFamily(font, font.ui, 'ui', uiFontStylesheetName(font))
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(dirname(outDir), { recursive: true })
  renameSync(tmp, outDir)
  return summary
}
