import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyMinimalDiff, computeWordHunks } from '../../../server/utils/ai/tools/sections/ytextDiff'

function docWith(text: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('codemirror')
  ytext.insert(0, text)
  return { ydoc, ytext }
}

function anchorAt(ytext: Y.Text, index: number) {
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, index))
}

function resolve(ydoc: Y.Doc, encoded: Uint8Array): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(encoded), ydoc)
  return abs ? abs.index : null
}

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const WORDS = ['alpha', 'beta', 'gamma', 'Kunde', 'Klient', 'über', '😀', '#', '\n', ' ', '  ', '.', ',', 'x', 'MyProduct', '`code`']

function randomText(rand: () => number, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += WORDS[Math.floor(rand() * WORDS.length)]
  return out
}

function mutate(rand: () => number, text: string): string {
  const tokens = text.match(/[\p{L}\p{N}_]+|\s+|[\s\S]/gu) ?? []
  const out: string[] = []
  for (const t of tokens) {
    const r = rand()
    if (r < 0.1) continue
    if (r < 0.2) out.push(WORDS[Math.floor(rand() * WORDS.length)]!)
    else if (r < 0.25) out.push(t, WORDS[Math.floor(rand() * WORDS.length)]!)
    else out.push(t)
  }
  return out.join('')
}

describe('applyMinimalDiff', () => {
  it('round-trips random edits of random sub-ranges', () => {
    const rand = rng(42)
    for (let round = 0; round < 500; round++) {
      const text = randomText(rand, 5 + Math.floor(rand() * 60))
      const { ydoc, ytext } = docWith(text)
      const start = Math.floor(rand() * (text.length + 1))
      const end = start + Math.floor(rand() * (text.length - start + 1))
      // keep the range on code point boundaries like the tools do
      const original = text.slice(start, end)
      if (/^[\uDC00-\uDFFF]/.test(original) || /[\uD800-\uDBFF]$/.test(original)) continue
      const replacement = mutate(rand, original)
      ydoc.transact(() => applyMinimalDiff(ytext, start, end, replacement))
      expect(ytext.toString()).toBe(text.slice(0, start) + replacement + text.slice(end))
      expect(ytext.toString()).not.toContain('�')
    }
  })

  it('reports no change for identical text', () => {
    const { ytext } = docWith('hello world')
    expect(applyMinimalDiff(ytext, 0, 11, 'hello world')).toEqual({ changed: false, insertedChars: 0, deletedChars: 0 })
  })

  it('keeps anchors on unchanged words when one word changes', () => {
    const text = 'Der Kunde zahlt. Der Kunde bleibt treu.'
    const { ydoc, ytext } = docWith(text)
    const zahlt = text.indexOf('zahlt')
    const treu = text.indexOf('treu')
    const aZahlt = anchorAt(ytext, zahlt)
    const aTreu = anchorAt(ytext, treu)
    const next = 'Der Klient zahlt. Der Klient bleibt treu.'
    let transactions = 0
    ydoc.on('afterTransaction', () => transactions++)
    ydoc.transact(() => applyMinimalDiff(ytext, 0, text.length, next))
    expect(transactions).toBe(1)
    expect(ytext.toString()).toBe(next)
    expect(resolve(ydoc, aZahlt)).toBe(next.indexOf('zahlt'))
    expect(resolve(ydoc, aTreu)).toBe(next.indexOf('treu'))
  })

  it('only touches the changed words (hunks)', () => {
    const hunks = computeWordHunks('one two three four five', 'one TWO three four FIVE')
    expect(hunks.map(h => h.insertText)).toEqual(['TWO', 'FIVE'])
  })

  it('anchors on words that survive random rewrites still point at the same word', () => {
    const rand = rng(7)
    for (let round = 0; round < 100; round++) {
      const words = Array.from({ length: 20 }, (_, i) => `w${i}`)
      const text = words.join(' ')
      const { ydoc, ytext } = docWith(text)
      const anchors = words.map(w => ({ w, a: anchorAt(ytext, text.indexOf(`${w} `) >= 0 ? text.indexOf(`${w} `) : text.lastIndexOf(w)) }))
      const kept = words.filter(() => rand() > 0.3)
      const next = kept.map(w => (rand() < 0.2 ? `${w} new` : w)).join(' ')
      ydoc.transact(() => applyMinimalDiff(ytext, 0, text.length, next))
      expect(ytext.toString()).toBe(next)
      for (const { w, a } of anchors) {
        if (!kept.includes(w)) continue
        const at = resolve(ydoc, a)!
        expect(ytext.toString().slice(at, at + w.length)).toBe(w)
      }
    }
  })

  it('never splits a surrogate pair', () => {
    const { ydoc, ytext } = docWith('a😀b')
    ydoc.transact(() => applyMinimalDiff(ytext, 0, 4, 'a😁b'))
    expect(ytext.toString()).toBe('a😁b')
  })
})
