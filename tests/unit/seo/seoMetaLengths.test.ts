import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  DEFAULT_TITLE,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  applyTitleTemplate
} from '../../../shared/seo/meta'
import { MARKETING_LOCALES } from '../../../shared/seo/marketing'

// Every indexable static page fits a search result: the rendered <title>
// (page title + " · markoto") ≤ 60 characters, the meta description
// ≤ 160. Docs pages take both from their frontmatter; / and /pricing from
// the i18n strings they pass to useMarketingSeo, in every locale.

const ROOT = join(__dirname, '..', '..', '..')
const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return markdownFiles(full)
    return name.endsWith('.md') ? [full] : []
  })
}

function frontmatter(file: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))
  if (!match?.[1]) return {}
  const data: unknown = parseYaml(match[1])
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

function lookup(messages: unknown, key: string): string {
  let node: unknown = messages
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined
  }
  if (typeof node !== 'string') throw new Error(`missing i18n key ${key}`)
  return node
}

describe('title template', () => {
  it('suffixes page titles with · markoto and falls back to the default title', () => {
    expect(applyTitleTemplate('Pricing')).toBe('Pricing · markoto')
    expect(applyTitleTemplate('')).toBe(DEFAULT_TITLE)
    expect(applyTitleTemplate(undefined)).toBe(DEFAULT_TITLE)
  })
})

describe('docs pages (content/docs frontmatter)', () => {
  const files = markdownFiles(join(ROOT, 'content', 'docs'))

  it('finds the docs', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    it(`${rel}: title ≤ ${MAX_TITLE_LENGTH} with suffix, description set and ≤ ${MAX_DESCRIPTION_LENGTH}`, () => {
      const fm = frontmatter(file)
      expect(typeof fm.title, 'title').toBe('string')
      expect(typeof fm.description, 'description').toBe('string')
      expect(applyTitleTemplate(String(fm.title)).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      const description = String(fm.description)
      expect(description.trim().length).toBeGreaterThan(0)
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    })
  }
})

describe('marketing pages (/, /pricing, /docs), every locale', () => {
  it('home title (untemplated) fits', () => {
    expect(DEFAULT_TITLE.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
  })

  for (const locale of LOCALES) {
    const messages: unknown = JSON.parse(readFileSync(join(ROOT, 'i18n', 'locales', `${locale}.json`), 'utf8'))
    it(`${locale}: titles and descriptions fit`, () => {
      for (const key of ['pricing.title', 'pricing.selfHostedTitle', 'docs.landing.metaTitle']) {
        expect(applyTitleTemplate(lookup(messages, key)).length, key).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      }
      for (const key of [
        'landing.subtitle',
        'tour.hero.body',
        'pricing.metaDescription',
        'pricing.comingSoonSubtitle',
        'pricing.selfHostedSubtitle',
        'docs.landing.metaDescription'
      ]) {
        expect(lookup(messages, key).length, key).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      }
    })
  }
})

describe('marketing pages (content/marketing frontmatter)', () => {
  const dir = join(ROOT, 'content', 'marketing')
  const files = markdownFiles(dir)

  it('finds the marketing pages', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    it(`${rel}: title ≤ ${MAX_TITLE_LENGTH} with suffix, description ≤ ${MAX_DESCRIPTION_LENGTH}, valid language folder`, () => {
      const fm = frontmatter(file)
      expect(typeof fm.title, 'title').toBe('string')
      expect(typeof fm.description, 'description').toBe('string')
      expect(applyTitleTemplate(String(fm.title)).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      const description = String(fm.description)
      expect(description.trim().length).toBeGreaterThan(0)
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      const locale = file.slice(dir.length + 1).split('/')[0]
      expect(MARKETING_LOCALES.some(l => l === locale), `language folder ${locale}`).toBe(true)
      expect(fm.updated === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(fm.updated)), `updated: ${String(fm.updated)}`).toBe(true)
    })
  }
})
