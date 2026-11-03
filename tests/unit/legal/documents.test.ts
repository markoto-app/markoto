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

  // Claims the code does not back. Each was in an earlier draft.
  it('makes no claims the product does not back (authoritative English)', () => {
    const privacy = read('privacy', 'en')
    // Accounts have no passwords (OAuth only); only document passwords use scrypt.
    expect(privacy).not.toMatch(/scrypt password hashing/i)
    // No analytics or session replay is loaded, and there is no cookie banner.
    expect(privacy).not.toMatch(/with your consent, which you can grant or withdraw/i)
    expect(privacy).toMatch(/no analytics, no session replay/i)
    // The age rule is 16 everywhere, not "16 in most EU states".
    for (const { slug } of DOCS) {
      expect(read(slug, 'en')).not.toMatch(/most EU member states/i)
    }
    // Anonymous documents: 30 days without activity.
    expect(read('terms', 'en')).toMatch(/\*\*30 days\*\*/)
    expect(privacy).toMatch(/deleted automatically after \*\*30 days\*\* without activity/)
    expect(privacy).not.toMatch(/180 days without activity/)
  })

  // The periods the retention sweeps enforce (server/utils/legalRetentionSweep.ts).
  it('states the audit-log and abuse-report retention the sweeps enforce', () => {
    const privacy = read('privacy', 'en')
    expect(privacy).toMatch(/Entries are deleted automatically after \*\*2 years\*\*/)
    expect(privacy).toMatch(/delete it, with these notices, \*\*1 year after the case is closed\*\*/)
    expect(privacy).not.toMatch(/Entries are currently not deleted automatically/i)
    expect(read('dpa', 'en')).toMatch(/Entries are deleted automatically after 2 years/)
    expect(read('abuse-policy', 'en')).toMatch(/delete it 1 year after it is closed/)
  })

  it('lists the anonymous terms cookie and no third-party font or CDN hosts', () => {
    const privacy = read('privacy', 'en')
    expect(privacy).toMatch(/`markoto-anon-terms`/)
    for (const { slug } of DOCS) {
      for (const locale of LEGAL_DOCUMENT_LOCALES) {
        const text = read(slug, locale)
        expect(text).not.toMatch(/Google Fonts|jsDelivr/)
        expect(text).not.toMatch(/SameSite=Strict/)
      }
    }
  })

  it('terms carry an acceptable-use section reachable from the terms link', () => {
    const terms = read('terms', 'en')
    expect(terms).toMatch(/^## 6\. Acceptable use$/m)
    for (const topic of [/phishing/i, /spam/i, /malware/i, /scrapers/i, /CDN/, /prompt injection/i, /Impersonate/i, /special categories/i]) {
      expect(terms).toMatch(topic)
    }
  })

  it('the liability cap is a fixed amount, not the (zero) fees paid', () => {
    const terms = read('terms', 'en')
    expect(terms).toMatch(/CHF 100/)
    expect(terms).not.toMatch(/fees you paid us/i)
  })
})
