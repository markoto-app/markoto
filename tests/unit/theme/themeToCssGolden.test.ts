import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { themeFontsImport, themeToCss, type ThemeRuntime } from '../../../shared/utils/theme/themeToCss'
import { defaultTheme } from '../../../shared/utils/theme/defaultTheme'
import { THEME_PRESETS } from '../../../shared/utils/theme/themePresets'
import { sanitizeCustomCss } from '../../../shared/utils/theme/customCss'
import {
  CodeBackgroundSchema,
  CodeFrameSchema,
  CodeThemeSchema,
  CoverLayoutSchema,
  HeadingNumberingSchema,
  HrStyleSchema,
  MermaidThemeSchema,
  PageSizeSchema,
  ReferenceStyleSchema,
  TableBordersSchema,
  TableHeaderBgSchema,
  TocLeaderStyleSchema,
  type DocTheme
} from '../../../shared/types/theme'

// Golden output of `themeToCss` + `themeFontsImport`: one SHA-256 per case,
// for every built-in preset and for themes that switch on every optional
// field and enum value. The stylesheet drives the preview AND the PDF, so a
// refactor of the generator must leave every byte as it was; a deliberate
// look change regenerates the file with `UPDATE_GOLDEN=1 bun run test:unit
// tests/unit/theme/themeToCssGolden.test.ts` and shows up in review as the
// changed hashes.

const GOLDEN_PATH = fileURLToPath(new URL('./themeToCss.golden.json', import.meta.url))

type Patch = { [K in keyof DocTheme]?: Partial<DocTheme[K]> }

function withPatch(base: DocTheme, patch: Patch): DocTheme {
  const out: Record<string, unknown> = structuredClone(base)
  for (const [section, fields] of Object.entries(patch)) {
    const current = out[section]
    out[section] = typeof current === 'object' && current !== null && !Array.isArray(current)
      ? { ...current, ...(fields as object) }
      : fields
  }
  return out as DocTheme
}

const plainRuntime: ThemeRuntime = { title: 'Golden Document', date: '29 October 2026', tocTitle: 'Contents' }

const richRuntime: ThemeRuntime = {
  title: 'Golden Document',
  date: '29. Oktober 2026',
  tocTitle: 'Inhalt',
  captionLabels: { table: 'Tabelle', figure: 'Abbildung', separator: ': ', chapter: { before: 'Kapitel ', after: '' } },
  customCss: sanitizeCustomCss('.paged-doc p { color: #123456; }\n.paged-doc h2 { letter-spacing: 0.02em; }', { docId: 'doc1', allowedOrigins: [] }),
  imageUrl: url => `${url}?token=t`
}

const enumCases = (name: string, values: readonly string[], patch: (v: string) => Patch): Array<[string, Patch]> =>
  values.map(v => [`${name}=${v}`, patch(v)])

const VARIANTS: Array<[string, Patch]> = [
  ...enumCases('page.size', PageSizeSchema.options, v => ({ page: { size: v as DocTheme['page']['size'] } })),
  ['page.landscape+perSideMargins+mirror', { page: { orientation: 'landscape', margin: 20, marginTop: 30, marginRight: 15, marginBottom: 40, marginLeft: 25, mirrorMargins: true } }],
  ['body.justify+hyphenate+indent+everyChapterDropCap', { body: { textAlign: 'justify', hyphenate: true, firstLineIndent: true, paragraphSpacing: 0.1, dropCap: 'every-chapter' } }],
  ['body.noDropCap', { body: { dropCap: false } }],
  ['body.mathSmallXHeightFont', { body: { font: 'EB Garamond' } }],
  ...enumCases('headings.numbering', HeadingNumberingSchema.options, v => ({ headings: { numbering: v as DocTheme['headings']['numbering'] } })),
  ['headings.numberingDepth=2+chapterLabel', { headings: { numbering: 'decimal', numberingDepth: 2, chapterLabel: true, chapterWord: 'Chapter' } }],
  ['headings.chapterLabelNoWord', { headings: { numbering: 'decimal-dot', chapterLabel: true, chapterWord: '' } }],
  ['headings.levels', { headings: { underline: true, levels: { h1: { size: 1.6, weight: 700, smallCaps: true, align: 'center' }, h2: { style: 'italic', weight: 400 }, h3: { size: 1.1, align: 'center' }, h4: { smallCaps: true } } } }],
  ['layout.columns=2', { layout: { columns: 2, columnGap: 6 } }],
  ['layout.columns=3', { layout: { columns: 3, columnGap: 4 } }],
  ['header+footer.allSlots', {
    header: { left: '{title}', center: '{section}', right: '{date}', imageUrl: '', imagePosition: 'left', imageHeight: 12, rule: true, sectionNumber: true, sectionMode: 'start' },
    footer: { left: '{author}', center: 'Page {page} of {pages}', right: 'Draft', imageUrl: '', imagePosition: 'center', imageHeight: 10, rule: true }
  }],
  ['header.image', { header: { left: 'x', center: '', right: '', imageUrl: '/markoto-logos/primary-lockup-light.svg', imagePosition: 'right', imageHeight: 14 } }],
  ['footer.imageCenter', { footer: { left: '', center: '{page}', right: '', imageUrl: '/markoto-logos/primary-lockup-light.svg', imagePosition: 'center', imageHeight: 9 } }],
  ...enumCases('code.theme', CodeThemeSchema.options, v => ({ code: { theme: v as DocTheme['code']['theme'] } })),
  ...enumCases('code.background', CodeBackgroundSchema.options, v => ({ code: { background: v as DocTheme['code']['background'], theme: 'github-dark' } })),
  ...enumCases('code.frame', CodeFrameSchema.options, v => ({ code: { frame: v as DocTheme['code']['frame'] } })),
  ['code.noWrap+lineNumbers+systemFont', { code: { wrap: false, lineNumbers: true, font: undefined } }],
  ...enumCases('tables.borders', TableBordersSchema.options, v => ({ tables: { borders: v as DocTheme['tables']['borders'] } })),
  ...enumCases('tables.headerBackground', TableHeaderBgSchema.options, v => ({ tables: { headerBackground: v as DocTheme['tables']['headerBackground'], headerTextColor: 'auto' } })),
  ['tables.zebra+below+label', { tables: { zebra: true, captionPosition: 'below', captionLabel: true, cellPadding: 3 } }],
  ...enumCases('blocks.hrStyle', HrStyleSchema.options, v => ({ blocks: { hrStyle: v as DocTheme['blocks']['hrStyle'] } })),
  ...enumCases('blocks.blockquoteStyle', ['border', 'background', 'none'], v => ({ blocks: { blockquoteStyle: v as DocTheme['blocks']['blockquoteStyle'] } })),
  ...enumCases('blocks.referenceStyle', ReferenceStyleSchema.options, v => ({ blocks: { referenceStyle: v as DocTheme['blocks']['referenceStyle'] } })),
  ['blocks.figureLabel+chapterNumbering+stacked', { blocks: { figureLabel: true, captionNumbering: 'chapter', captionLabelStyle: 'stacked', imageRadius: 6, imageMaxWidth: 70 }, tables: { captionLabel: true }, headings: { numbering: 'decimal' } }],
  ...enumCases('mermaid.theme', MermaidThemeSchema.options, v => ({ mermaid: { theme: v as DocTheme['mermaid']['theme'] } })),
  ...enumCases('toc.leaderStyle', TocLeaderStyleSchema.options, v => ({ toc: { leaderStyle: v as DocTheme['toc']['leaderStyle'], maxDepth: 4, showTitle: false, showPageNumbers: true } })),
  ['toc.noPageNumbers', { toc: { showPageNumbers: false, maxDepth: 2 } }],
  ...CoverLayoutSchema.options.flatMap(layout => (['left', 'center', 'right'] as const).map((align): [string, Patch] => [
    `cover.${layout}.${align}`,
    { cover: { enabled: true, layout, align, showLogo: true, showSubtitle: true, subtitle: 'Sub', showAuthors: true, authors: ['A', 'B'], affiliations: ['X', 'Y'], showDate: true } }
  ])),
  ['cover.titleBlock+rules+smallCaps+weight+repeatTitle', { cover: { enabled: true, layout: 'title-block', rules: true, smallCaps: true, titleWeight: 300, repeatTitle: true, dateFormat: 'iso', date: '2026-10-29' } }],
  ['cover.classic+repeatTitle', { cover: { enabled: true, layout: 'classic', repeatTitle: true, titleSize: 3.2, subtitleSize: 1.4 } }],
  ['cover.disabled', { cover: { enabled: false } }]
]

function digest(theme: DocTheme, runtime: ThemeRuntime): string {
  const css = themeToCss(theme, runtime)
  const fonts = themeFontsImport(theme)
  return createHash('sha256').update(css).update('\n/*fonts*/\n').update(fonts).digest('hex')
}

function computeAll(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const preset of THEME_PRESETS) {
    out[`preset:${preset.id}:plain`] = digest(preset.theme, plainRuntime)
    out[`preset:${preset.id}:rich`] = digest(preset.theme, richRuntime)
  }
  for (const [name, patch] of VARIANTS) {
    const theme = withPatch(defaultTheme, patch)
    out[`variant:${name}:plain`] = digest(theme, plainRuntime)
    out[`variant:${name}:rich`] = digest(theme, richRuntime)
  }
  return out
}

describe('themeToCss golden output', () => {
  const actual = computeAll()

  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`)
  }

  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>

  test('covers every case (no case added or dropped without regenerating)', () => {
    expect(Object.keys(actual).sort((a, b) => a.localeCompare(b))).toEqual(Object.keys(golden).sort((a, b) => a.localeCompare(b)))
  })

  test.each(Object.keys(actual))('%s is byte-identical', (name) => {
    expect(actual[name]).toBe(golden[name])
  })
})
