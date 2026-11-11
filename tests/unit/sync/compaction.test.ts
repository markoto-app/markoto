// Unit tests for the CRDT-correctness core of background compaction
// (sync-server/src/compaction.ts). Imported cross-package from the root
// unit tier (like tests/unit/sync/syncAuth.test.ts) so it runs in CI — the
// sync-server's own src/__tests__ suite is not wired into the CI vitest.
//
// The DB orchestration (compactDocument / runCompactionSweep) needs a live
// Postgres and is covered by design + review; what MUST be pinned here is
// that merging granular updates preserves document state, AND that an
// update NOT folded into the merge (the concurrency case: rows appended
// after the ceiling snapshot) still reconstructs correctly on top of the
// merged row. That invariant is the whole reason the sweep is safe.

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { mergeUpdates } from '../../../sync-server/src/compaction'

// Capture the sequence of incremental updates a doc emits as it's edited —
// this mirrors the granular `v1` rows y-postgresql appends per store.
function recordUpdates(build: (doc: Y.Doc) => void): { updates: Uint8Array[], finalText: string } {
  const doc = new Y.Doc()
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  build(doc)
  const finalText = doc.getText('content').toString()
  doc.destroy()
  return { updates, finalText }
}

function textFromUpdates(updates: Uint8Array[]): string {
  const doc = new Y.Doc()
  for (const u of updates) Y.applyUpdate(doc, u)
  const t = doc.getText('content').toString()
  doc.destroy()
  return t
}

describe('mergeUpdates', () => {
  it('merges granular updates into one equivalent update (state preserved)', () => {
    const { updates, finalText } = recordUpdates((doc) => {
      const t = doc.getText('content')
      t.insert(0, 'Hello')
      t.insert(5, ' world')
      t.insert(0, '# ')
      t.delete(2, 5) // delete "Hello"
      t.insert(2, 'Hi')
    })
    expect(updates.length).toBeGreaterThan(1)

    const merged = mergeUpdates(updates)

    // A fresh doc with ONLY the merged update reconstructs the same state.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, merged)
    expect(doc.getText('content').toString()).toBe(finalText)
    doc.destroy()
  })

  it('preserves a ymeta map alongside the text (title/theme survive compaction)', () => {
    const { updates } = recordUpdates((doc) => {
      doc.getText('content').insert(0, 'body')
      const meta = doc.getMap('meta')
      meta.set('title', 'My Document')
      meta.set('theme', { page: { size: 'A4' } })
    })

    const doc = new Y.Doc()
    Y.applyUpdate(doc, mergeUpdates(updates))
    expect(doc.getMap('meta').get('title')).toBe('My Document')
    expect(doc.getMap('meta').get('theme')).toEqual({ page: { size: 'A4' } })
    doc.destroy()
  })

  it('a concurrent update left OUT of the merge still applies on top (race-safety invariant)', () => {
    // Simulate the sweep boundary: rows 1..N are read + merged (id <=
    // ceiling); row N+1 is appended by a live writer AFTER the ceiling
    // snapshot, so it is NOT in the merge and NOT deleted. On the next load
    // the merged row + row N+1 must together reconstruct the full state.
    const doc = new Y.Doc()
    const belowCeiling: Uint8Array[] = []
    const afterCeiling: Uint8Array[] = []
    // Route each update into the current batch via a mutable target so the
    // "ceiling" split is a single clean handoff.
    let target = belowCeiling
    doc.on('update', (u: Uint8Array) => target.push(u))

    doc.getText('content').insert(0, 'first batch')
    target = afterCeiling // ceiling snapshot happens here
    doc.getText('content').insert(11, ' + concurrent tail')
    const expected = doc.getText('content').toString()
    doc.destroy()

    expect(belowCeiling.length).toBeGreaterThan(0)
    expect(afterCeiling.length).toBeGreaterThan(0)

    const merged = mergeUpdates(belowCeiling)

    // Load order mirrors y-postgresql's `ORDER BY id`: merged row (higher
    // id, appended last) sorts AFTER the concurrent row — but Y.js updates
    // are commutative, so either order yields the same state. Assert both.
    expect(textFromUpdates([merged, ...afterCeiling])).toBe(expected)
    expect(textFromUpdates([...afterCeiling, merged])).toBe(expected)
  })

  it('is idempotent — merging an already-merged update is a no-op in state', () => {
    const { updates, finalText } = recordUpdates((doc) => {
      doc.getText('content').insert(0, 'stable content')
    })
    const once = mergeUpdates(updates)
    const twice = mergeUpdates([once])
    expect(textFromUpdates([twice])).toBe(finalText)
  })
})
