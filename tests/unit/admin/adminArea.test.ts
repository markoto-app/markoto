import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import en from '../../../i18n/locales/en.json'
import de from '../../../i18n/locales/de.json'
import fr from '../../../i18n/locales/fr.json'
import es from '../../../i18n/locales/es.json'
import ja from '../../../i18n/locales/ja.json'
import zh from '../../../i18n/locales/zh.json'
import { ADMIN_SECTIONS, adminSectionOf } from '../../../app/utils/admin/adminSections'

// The admin area: every admin page is in the navigation, a path maps to
// its section, and every admin text exists in all six languages.

type Tree = { [k: string]: string | Tree }

function flatten(o: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else Object.assign(out, flatten(v, key))
  }
  return out
}

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? pagesUnder(join(dir, e.name)) : e.name.endsWith('.vue') ? [join(dir, e.name)] : [])
}

describe('admin navigation', () => {
  it('lists every page under app/pages/admin', () => {
    const root = join(__dirname, '../../../app/pages')
    const routes = pagesUnder(join(root, 'admin'))
      .map(f => `/${relative(root, f).replace(/\.vue$/, '').replace(/\/index$/, '')}`)
    expect(routes.sort()).toEqual(ADMIN_SECTIONS.map(s => s.to).sort())
  })

  it('maps a path to the most specific section', () => {
    expect(adminSectionOf('/admin')).toBe('overview')
    expect(adminSectionOf('/admin/')).toBe('overview')
    expect(adminSectionOf('/admin/stats')).toBe('stats')
    expect(adminSectionOf('/admin/stats/investor')).toBe('investor')
    expect(adminSectionOf('/admin/abuse-reports')).toBe('abuseReports')
    expect(adminSectionOf('/settings/ai')).toBeNull()
  })
})

describe('admin texts', () => {
  const english = { ...flatten((en as unknown as Tree).admin as Tree, 'admin'), ...flatten((en as unknown as Tree).adminStats as Tree, 'adminStats') }
  const locales = { de, fr, es, ja, zh } as unknown as Record<string, Tree>

  it.each(Object.keys(locales))('%s has every admin key, translated', (code) => {
    const tree = locales[code]!
    const other = { ...flatten(tree.admin as Tree, 'admin'), ...flatten(tree.adminStats as Tree, 'adminStats') }
    for (const key of Object.keys(english)) {
      expect(other[key], `${code} ${key}`).toBeTruthy()
    }
    // Sentences, not just labels that read the same in every language.
    for (const key of ['admin.abuse.intro', 'admin.abuse.explanationPlaceholder', 'admin.aiSpend.intro', 'admin.hub.intro']) {
      expect(other[key], `${code} ${key}`).not.toBe(english[key])
    }
  })

  it('German says du, uses Swiss spelling and no text has an em-dash', () => {
    const german = { ...flatten((de as unknown as Tree).admin as Tree), ...flatten((de as unknown as Tree).adminStats as Tree) }
    for (const text of Object.values(german)) {
      expect(text).not.toContain('ß')
      expect(text).not.toMatch(/\b(Sie|Ihre?n?)\b/)
    }
    for (const tree of [en, de, fr, es, ja, zh] as unknown as Tree[]) {
      for (const text of Object.values(flatten(tree.admin as Tree))) expect(text).not.toContain(String.fromCodePoint(0x2014))
    }
  })
})
