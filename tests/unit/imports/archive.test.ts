import { describe, it, expect } from 'vitest'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { ArchiveRejectedError, extractArchiveEntries, listArchive } from '../../../server/utils/imports/archive'
import { IMPORT_ARCHIVE_MAX_ENTRIES } from '../../../shared/config/imports'

const BIG = 1024 * 1024 * 1024

function zip(files: Record<string, string | Uint8Array>, level: 0 | 9 = 9): Uint8Array {
  const z: Zippable = {}
  for (const [name, content] of Object.entries(files)) z[name] = [typeof content === 'string' ? strToU8(content) : content, { level }]
  return zipSync(z)
}

function rejection(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof ArchiveRejectedError ? e.reason : `other: ${String(e)}`
  }
}

describe('listArchive', () => {
  it('lists file entries with normalised paths and declared sizes, without directories', () => {
    const data = zip({ 'docs/': new Uint8Array(0), 'docs/a.md': '# A', 'b.md': 'hello' })
    const listing = listArchive(data, { maxExpandedBytes: BIG })
    expect(listing.entries.map(e => [e.path, e.rawName, e.size])).toEqual([
      ['docs/a.md', 'docs/a.md', 3],
      ['b.md', 'b.md', 5]
    ])
    expect(listing.expandedBytes).toBe(8)
    expect(listing.skipped).toBe(0)
  })

  it('skips entries that climb out of the archive and hidden / system files', () => {
    const data = zip({
      '../evil.md': 'x',
      'a/../../evil2.md': 'x',
      '.git/config': 'x',
      '__MACOSX/._a.md': 'x',
      'ok/c.md': 'x'
    })
    const listing = listArchive(data, { maxExpandedBytes: BIG })
    expect(listing.entries.map(e => e.path)).toEqual(['ok/c.md'])
    expect(listing.skipped).toBe(4)
  })

  it('normalises absolute and backslash names into the archive', () => {
    const listing = listArchive(zip({ '/abs/x.md': 'x', 'win\\y.md': 'y' }), { maxExpandedBytes: BIG })
    expect(listing.entries.map(e => e.path)).toEqual(['abs/x.md', 'win/y.md'])
  })

  it('strips the leading folder of a GitHub download and filters by `under`', () => {
    const data = zip({
      'repo-main/README.md': 'r',
      'repo-main/docs/guide.md': 'g',
      'repo-main/docs/deep/x.md': 'x',
      'repo-main/docsish/no.md': 'n',
      'top-level.md': 't'
    })
    const all = listArchive(data, { maxExpandedBytes: BIG, stripPrefix: true })
    expect(all.entries.map(e => e.path)).toEqual(['README.md', 'docs/guide.md', 'docs/deep/x.md', 'docsish/no.md'])
    expect(all.skipped).toBe(1)

    const docs = listArchive(data, { maxExpandedBytes: BIG, stripPrefix: true, under: 'docs' })
    expect(docs.entries.map(e => [e.path, e.rawName])).toEqual([
      ['guide.md', 'repo-main/docs/guide.md'],
      ['deep/x.md', 'repo-main/docs/deep/x.md']
    ])
  })

  it('refuses an entry that inflates past the ratio (zip bomb)', () => {
    const data = zip({ 'bomb.md': new Uint8Array(4 * 1024 * 1024) })
    expect(rejection(() => listArchive(data, { maxExpandedBytes: BIG }))).toBe('ratio')
  })

  it('lets highly compressible small entries through (the ratio applies above 1 MiB)', () => {
    const data = zip({ 'small.md': new Uint8Array(512 * 1024) })
    expect(listArchive(data, { maxExpandedBytes: BIG }).entries).toHaveLength(1)
  })

  it('refuses an archive that expands past the byte budget', () => {
    const data = zip({ 'a.md': 'x'.repeat(600), 'b.md': 'y'.repeat(600) }, 0)
    expect(rejection(() => listArchive(data, { maxExpandedBytes: 1000 }))).toBe('too-large')
    expect(listArchive(data, { maxExpandedBytes: 1200 }).expandedBytes).toBe(1200)
  })

  it('refuses an archive with too many entries', () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i <= IMPORT_ARCHIVE_MAX_ENTRIES; i++) files[`f${i}.md`] = new Uint8Array(0)
    expect(rejection(() => listArchive(zip(files, 0), { maxExpandedBytes: BIG }))).toBe('too-many-entries')
  })

  it('refuses bytes that are not a zip', () => {
    expect(rejection(() => listArchive(strToU8('definitely not a zip file'), { maxExpandedBytes: BIG }))).toBe('unreadable')
  })
})

describe('extractArchiveEntries', () => {
  it('inflates only the named entries', () => {
    const data = zip({ 'a.md': 'alpha', 'b.md': 'beta', 'c.md': 'gamma' })
    const out = extractArchiveEntries(data, new Set(['a.md', 'c.md', 'missing.md']))
    expect([...out.keys()].sort()).toEqual(['a.md', 'c.md'])
    expect(new TextDecoder().decode(out.get('c.md'))).toBe('gamma')
  })

  it('returns nothing for an empty selection', () => {
    expect(extractArchiveEntries(zip({ 'a.md': 'x' }), new Set()).size).toBe(0)
  })
})
