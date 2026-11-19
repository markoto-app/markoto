// llms.txt and llms-full.txt for the hosted marketing site (llmstxt.org):
// a short summary of markoto with a linked index of the public marketing
// pages and the user docs, and the full text of the user docs in one file.
// English only, public content only: content/docs (the /docs site) and
// the English marketing pages. The operator docs in docs/ are not content
// and never appear here.
//
// Pure: server/utils/platform/llmsSources.ts reads the Markdown files,
// server/routes/llms.txt.ts + llms-full.txt.ts serve the result (marketing
// site only, like the sitemap).

import { parse as parseYaml } from 'yaml'
import { compareCodeUnits } from '../../../shared/utils/compareCodeUnits'

/** One Markdown file: its path relative to its content folder and its text. */
export interface SourceFile {
  /** `getting-started/index.md`, `compare/hackmd.md`. */
  path: string
  raw: string
}

export interface Frontmatter {
  title?: string
  description?: string
  order?: number
  navGroup?: string
  reviewed?: boolean
}

/** Frontmatter (YAML between `---` lines) and the body after it. */
export function splitFrontmatter(raw: string): { data: Frontmatter, body: string } {
  const text = (raw.startsWith('﻿') ? raw.slice(1) : raw).replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const parsed: unknown = parseYaml(match[1] ?? '')
  const data = parsed && typeof parsed === 'object' ? parsed as Frontmatter : {}
  return { data, body: text.slice(match[0].length) }
}

/** Route path of a content file under a route root: `getting-started/index.md` → `/docs/getting-started`. */
export function contentRoute(root: string, path: string): string {
  const slug = path.replace(/\.md$/, '').replace(/(^|\/)index$/, '')
  if (!slug) return root || '/'
  return `${root}/${slug}`
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * A docs page's Markdown for reading as plain text: Nuxt Content (MDC)
 * components removed (`::flow{id="x"}` … `::` blocks, inline
 * `:component{…}`), site-relative links made absolute, runs of blank
 * lines collapsed. Code blocks are left exactly as they are.
 */
export function cleanDocsMarkdown(body: string, base: string): string {
  const out: string[] = []
  const state: CleanState = { fence: null, depth: 0 }
  for (const line of body.replaceAll('\r\n', '\n').split('\n')) {
    const kept = cleanLine(line, state)
    if (kept === null) continue
    out.push(kept.code ? kept.text : absoluteLinks(withoutInlineComponents(kept.text), base))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

interface CleanState {
  /** Marker of the open fenced code block (``` or ~~~), or null. */
  fence: string | null
  /** Open MDC block components. */
  depth: number
}

/** One line of `cleanDocsMarkdown`: kept (as code or as text) or dropped (null); updates the state. */
function cleanLine(line: string, state: CleanState): { text: string, code: boolean } | null {
  const fenceMatch = FENCE_RE.exec(line)
  if (state.fence) {
    if (fenceMatch && line.trim().startsWith(state.fence)) state.fence = null
    return state.depth === 0 ? { text: line, code: true } : null
  }
  if (fenceMatch && state.depth === 0) {
    state.fence = fenceMatch[1] ?? null
    return { text: line, code: true }
  }
  const trimmed = line.trim()
  // Block component open (`::name{…}`, `:::name`) and close (`::`).
  if (/^:{2,}[a-z][\w-]*/i.test(trimmed)) {
    state.depth++
    return null
  }
  if (/^:{2,}$/.test(trimmed)) {
    state.depth = Math.max(0, state.depth - 1)
    return null
  }
  return state.depth > 0 ? null : { text: line, code: false }
}

/** Inline components (`:kbd{value="K"}`) become their `value`, or nothing. */
function withoutInlineComponents(line: string): string {
  return line.replace(/(^|\s):[a-z][\w-]*\{([^}]*)\}( ?)/gi, (_m, before: string, attrs: string, after: string) => {
    const value = /\bvalue="([^"]*)"/.exec(attrs)?.[1]
    return value ? `${before}${value}${after}` : before
  })
}

/** `](/docs/x)` → `](https://markoto.app/docs/x)`. */
function absoluteLinks(line: string, base: string): string {
  return line.replace(/\]\((\/[^)\s]*)\)/g, (_m, path: string) => `](${base}${path})`)
}

export interface IndexedPage {
  title: string
  url: string
  description?: string
  order?: number
}

export interface DocsSection {
  title: string
  description?: string
  order?: number
  pages: IndexedPage[]
}

function byOrderThenTitle(a: { order?: number, title: string }, b: { order?: number, title: string }): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  return ao - bo || compareCodeUnits(a.title, b.title)
}

/** The docs files grouped into sections (one folder each, its index page first), in sidebar order. */
export function docsSections(files: readonly SourceFile[], base: string): DocsSection[] {
  const sections = new Map<string, DocsSection>()
  for (const file of files) {
    const { data } = splitFrontmatter(file.raw)
    if (!data.title) continue
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : ''
    const section = sections.get(folder) ?? { title: folder, pages: [] }
    const page: IndexedPage = { title: data.title, url: `${base}${contentRoute('/docs', file.path)}`, description: data.description, order: data.order }
    if (/(^|\/)index\.md$/.test(file.path) && file.path.split('/').length <= 2) {
      section.title = data.title
      section.description = data.description
      section.order = data.order
      page.order = Number.MIN_SAFE_INTEGER
    }
    section.pages.push(page)
    sections.set(folder, section)
  }
  return [...sections.values()]
    .sort(byOrderThenTitle)
    .map(section => ({ ...section, pages: section.pages.toSorted(byOrderThenTitle) }))
}

export interface MarketingGroup {
  title: string
  pages: IndexedPage[]
}

const MARKETING_GROUP_TITLES: Readonly<Record<string, string>> = {
  'use-cases': 'Use cases',
  'compare': 'Comparisons',
  'templates': 'Templates'
}

/** The English marketing content pages grouped like the site footer (use cases, comparisons, templates, other pages). */
export function marketingGroups(files: readonly SourceFile[], base: string): MarketingGroup[] {
  const groups = new Map<string, IndexedPage[]>()
  for (const file of files) {
    const { data } = splitFrontmatter(file.raw)
    if (!data.title || data.reviewed === false) continue
    const top = file.path.split('/')[0] ?? ''
    // Hub pages (compare/index.md) carry no navGroup; they belong to their folder.
    const group = data.navGroup ?? (top in MARKETING_GROUP_TITLES ? top : 'other')
    const list = groups.get(group) ?? []
    list.push({ title: data.title, url: `${base}${contentRoute('', file.path)}`, description: data.description, order: /(^|\/)index\.md$/.test(file.path) ? Number.MIN_SAFE_INTEGER : data.order })
    groups.set(group, list)
  }
  const order = [...Object.keys(MARKETING_GROUP_TITLES), 'other']
  return order
    .filter(key => groups.has(key))
    .map(key => ({ title: MARKETING_GROUP_TITLES[key] ?? 'More pages', pages: (groups.get(key) ?? []).toSorted(byOrderThenTitle) }))
}

/** The product summary and the fixed pages (home, pricing, demo). English, like the docs. */
export const LLMS_SUMMARY = 'markoto is a collaborative Markdown editor with a live, paginated preview: write plain Markdown together in real time and export a PDF that matches the preview page for page.'

const LLMS_DETAILS = [
  'markoto runs as a hosted service at markoto.app (EU data path: hosting, storage and AI providers in the EU) and can be self-hosted from its source-available code (FSL-1.1-ALv2).',
  'Features: themes and cover pages for print-ready PDFs, Mermaid diagrams and KaTeX math, comments and version history, workspaces with a knowledge base, an AI assistant that edits the document with you (your own provider key or the hosted default), and an MCP server for external AI clients.',
  'Accounts are optional: public documents can be written without signing in.'
]

function uiPages(base: string): IndexedPage[] {
  return [
    { title: 'markoto', url: `${base}/`, description: 'Product tour: what the editor, preview, themes, AI and collaboration do.' },
    { title: 'Pricing', url: `${base}/pricing`, description: 'Plans, AI Points, workspaces and storage per plan.' },
    { title: 'Demo video', url: `${base}/demo`, description: 'markoto in two minutes.' }
  ]
}

function linkLine(page: IndexedPage): string {
  return `- [${page.title}](${page.url})${page.description ? `: ${page.description}` : ''}`
}

export interface LlmsInput {
  /** Site origin, no trailing slash. */
  base: string
  docs: readonly SourceFile[]
  marketing: readonly SourceFile[]
}

/** llms.txt: H1, summary blockquote, details, then H2 sections of links (llmstxt.org). */
export function buildLlmsTxt(input: LlmsInput): string {
  const { base } = input
  const lines = [
    '# markoto',
    '',
    `> ${LLMS_SUMMARY}`,
    '',
    ...LLMS_DETAILS.flatMap(p => [p, '']),
    `The complete user documentation as one Markdown file: ${base}/llms-full.txt`,
    '',
    '## Product',
    '',
    ...uiPages(base).map(linkLine),
    ''
  ]
  for (const group of marketingGroups(input.marketing, base)) {
    lines.push(`## ${group.title}`, '', ...group.pages.map(linkLine), '')
  }
  for (const section of docsSections(input.docs, base)) {
    lines.push(`## Docs: ${section.title}`, '', ...section.pages.map(linkLine), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** llms-full.txt: every docs page's text, in sidebar order, each under its title and URL. */
export function buildLlmsFullTxt(input: Pick<LlmsInput, 'base' | 'docs'>): string {
  const { base } = input
  const byPath = new Map(input.docs.map(f => [`${base}${contentRoute('/docs', f.path)}`, f]))
  const parts = [
    '# markoto documentation',
    '',
    `> ${LLMS_SUMMARY}`,
    '',
    `This file holds the full text of the markoto user documentation (${base}/docs). Index: ${base}/llms.txt`
  ]
  for (const section of docsSections(input.docs, base)) {
    for (const page of section.pages) {
      const file = byPath.get(page.url)
      if (!file) continue
      const body = cleanDocsMarkdown(splitFrontmatter(file.raw).body, base)
      // The page's own H1 repeats its title; drop it, the heading below names the page.
      const text = body.replace(/^# .*\n+/, '')
      parts.push('', '---', '', `# ${page.title}`, '', `Source: ${page.url}`, '', ...(page.description ? [`> ${page.description}`, ''] : []), text)
    }
  }
  return `${parts.join('\n').trimEnd()}\n`
}
