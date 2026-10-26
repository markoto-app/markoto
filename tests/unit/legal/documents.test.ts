import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ABUSE_POLICY_VERSION,
  DPA_VERSION,
  LEGAL_DOCUMENT_LOCALES,
  PRIVACY_VERSION,
  TOS_VERSION
} from '../../../shared/legal/versions'

// Pins the content/legal sources to the version registry and keeps every
// translation structurally in step with the authoritative English text.

const ROOT = join(__dirname, '..', '..', '..', 'content', 'legal')

const DOCS = [
  { slug: 'privacy', version: PRIVACY_VERSION },
  { slug: 'terms', version: TOS_VERSION },
  { slug: 'dpa', version: DPA_VERSION },
  { slug: 'abuse-policy', version: ABUSE_POLICY_VERSION }
] as const

function read(slug: string, locale: string): string {
  return readFileSync(join(ROOT, slug, `${locale}.md`), 'utf8')
}

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1] ?? ''))].sort()
}

function h2Count(text: string): number {
  return text.split('\n').filter(l => l.startsWith('## ')).length
}

describe.each(DOCS)('legal document $slug', ({ slug, version }) => {
  it('_meta.json carries the registry version', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, slug, '_meta.json'), 'utf8')) as { version: number }
    expect(meta.version).toBe(version)
  })

  const english = read(slug, 'en')

  it.each(LEGAL_DOCUMENT_LOCALES)('%s frontmatter version matches the registry', (locale) => {
    expect(read(slug, locale)).toMatch(new RegExp(`^version: ${version}$`, 'm'))
  })

  it.each(LEGAL_DOCUMENT_LOCALES.filter(l => l !== 'en'))('%s is a full translation of en', (locale) => {
    const text = read(slug, locale)
    expect(text).not.toMatch(/translationStatus: pending/)
    expect(placeholders(text)).toEqual(placeholders(english))
    expect(h2Count(text)).toBe(h2Count(english))
  })
})

describe('legal wording', () => {
  it('never uses the wrong company name', () => {
    for (const { slug } of DOCS) {
      for (const locale of LEGAL_DOCUMENT_LOCALES) {
        expect(read(slug, locale)).not.toMatch(/Latent Labs/i)
      }
    }
  })
})
