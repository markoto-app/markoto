import { describe, it, expect } from 'vitest'
import { effectScope, ref } from 'vue'
import * as Y from 'yjs'
import { useBibliography } from '~/composables/document/useBibliography'
import { BIBLIOGRAPHY_MAX_ENTRIES, type CslItem } from '~~/shared/utils/citations/cslItem'
import { BIBLIOGRAPHY_ROOT, CITATION_STYLE_META_KEY } from '~~/shared/utils/citations/docBibliography'

const item = (id: string, title = 'A Study'): CslItem => {
  const value: unknown = { id, type: 'book', title }
  return value as CslItem
}

function setup(readOnly = false) {
  const ydoc = new Y.Doc()
  const ymeta = ydoc.getMap<unknown>('meta')
  const isReadOnly = ref(readOnly)
  const scope = effectScope()
  const bib = scope.run(() => useBibliography(ydoc, ymeta, isReadOnly))!
  return { ydoc, ymeta, isReadOnly, scope, bib }
}

describe('useBibliography', () => {
  it('adds, replaces and reports entries; items follow the Y.Map', () => {
    const { bib, ydoc } = setup()
    expect(bib.addItems([item('a'), item('b')])).toEqual({ added: 2, replaced: 0, dropped: 0 })
    expect(bib.addItems([item('a', 'Newer'), item('c')])).toEqual({ added: 1, replaced: 1, dropped: 0 })
    expect(bib.items.value.map(i => i.id).sort()).toEqual(['a', 'b', 'c'])
    expect(bib.items.value.find(i => i.id === 'a')!.title).toBe('Newer')
    expect(bib.hasKey('c')).toBe(true)
    expect(ydoc.getMap(BIBLIOGRAPHY_ROOT).size).toBe(3)
    expect(bib.citations.value.items).toHaveLength(3)
  })

  it('reacts to entries written by another editor', () => {
    const { bib, ydoc } = setup()
    ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT).set('remote', JSON.stringify(item('remote')))
    expect(bib.items.value.map(i => i.id)).toEqual(['remote'])
  })

  it('removes entries', () => {
    const { bib } = setup()
    bib.addItems([item('a'), item('b')])
    bib.removeItem('a')
    expect(bib.hasKey('a')).toBe(false)
    expect(bib.items.value.map(i => i.id)).toEqual(['b'])
  })

  it('drops entries beyond the bibliography limit but still replaces existing keys', () => {
    const { bib } = setup()
    const many = Array.from({ length: BIBLIOGRAPHY_MAX_ENTRIES }, (_, i) => item(`k${i}`))
    bib.addItems(many)
    expect(bib.addItems([item('extra'), item('k0', 'Replaced')])).toEqual({ added: 0, replaced: 1, dropped: 1 })
    expect(bib.hasKey('extra')).toBe(false)
  })

  it('tracks and sets the citation style', () => {
    const { bib, ymeta } = setup()
    const before = bib.style.value
    bib.setStyle('ieee')
    expect(ymeta.get(CITATION_STYLE_META_KEY)).toBe('ieee')
    expect(bib.style.value).toBe('ieee')
    expect(bib.citations.value.style).toBe('ieee')
    expect(before).not.toBe('ieee')
    ymeta.set(CITATION_STYLE_META_KEY, 'apa')
    expect(bib.style.value).toBe('apa')
  })

  it('refuses every write while read-only, and writes again once editable', () => {
    const { bib, isReadOnly, ymeta } = setup(true)
    expect(bib.addItems([item('a')])).toEqual({ added: 0, replaced: 0, dropped: 0 })
    bib.setStyle('ieee')
    expect(ymeta.has(CITATION_STYLE_META_KEY)).toBe(false)
    isReadOnly.value = false
    bib.addItems([item('a')])
    bib.removeItem('a')
    expect(bib.hasKey('a')).toBe(false)
    isReadOnly.value = true
    bib.addItems([item('z')])
    bib.removeItem('nothing')
    expect(bib.hasKey('z')).toBe(false)
  })

  it('stops observing when its scope is disposed', () => {
    const { bib, ydoc, scope } = setup()
    scope.stop()
    ydoc.getMap<unknown>(BIBLIOGRAPHY_ROOT).set('late', JSON.stringify(item('late')))
    expect(bib.items.value).toEqual([])
  })

  it('treats an empty add as a no-op', () => {
    expect(setup().bib.addItems([])).toEqual({ added: 0, replaced: 0, dropped: 0 })
  })
})
