import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { findFileIdsInHistory, resolveImageGcRetentionDays, IMAGE_GC_DEFAULT_RETENTION_DAYS } from '../../../server/utils/storage/imageGc'
import { stagingKeyFor } from '../../../server/utils/storage/uploadKey'
import { memberShareOfWorkspaceSlots } from '../../../server/utils/knowledge/knowledgeQuota'

// The pure core of the image GC: "is this fileId visible in ANY version of
// the doc that can still be reconstructed from the stored update log?".
// A false negative here would delete an image a user can still restore,
// so every way an image reference can live in a doc is pinned.

/** Build an update log: each step mutates one shared doc and records the delta. */
function updateLog(steps: Array<(doc: Y.Doc) => void>): Uint8Array[] {
  const doc = new Y.Doc()
  const out: Uint8Array[] = []
  for (const step of steps) {
    const before = Y.encodeStateVector(doc)
    step(doc)
    out.push(Y.encodeStateAsUpdate(doc, before))
  }
  return out
}

const IMG = 'AAAAAAAAAAAA.png'
const OTHER = 'BBBBBBBBBBBB.png'

describe('findFileIdsInHistory', () => {
  it('finds a reference in the current text', () => {
    const log = updateLog([d => d.getText('content').insert(0, `![x](/api/files/doc1/${IMG})`)])
    expect(findFileIdsInHistory(log, [IMG, OTHER])).toEqual(new Set([IMG]))
  })

  it('finds a reference that only existed in a past (restorable) version', () => {
    const log = updateLog([
      d => d.getText('content').insert(0, `intro ![x](/api/files/doc1/${IMG}) outro`),
      (d) => {
        const t = d.getText('content')
        t.delete(0, t.length)
        t.insert(0, 'rewritten without the image')
      }
    ])
    expect(findFileIdsInHistory(log, [IMG])).toEqual(new Set([IMG]))
  })

  it('finds a reference typed piecewise across several stored rows', () => {
    const url = `/api/files/doc1/${IMG}`
    const log = updateLog([
      d => d.getText('content').insert(0, url.slice(0, 20)),
      d => d.getText('content').insert(20, url.slice(20))
    ])
    // No single row's bytes contain the whole id, the replayed text does.
    expect(log.some(u => new TextDecoder().decode(u).includes(IMG))).toBe(false)
    expect(findFileIdsInHistory(log, [IMG])).toEqual(new Set([IMG]))
  })

  it('finds references in the theme (meta map) and in comments', () => {
    const log = updateLog([
      d => d.getMap('meta').set('theme', { cover: { logoUrl: `/api/files/doc1/${IMG}` } }),
      (d) => {
        const c = new Y.Map<unknown>()
        c.set('body', `see /api/files/doc1/${OTHER}`)
        d.getArray('comments').push([c])
      }
    ])
    expect(findFileIdsInHistory(log, [IMG, OTHER])).toEqual(new Set([IMG, OTHER]))
  })

  it('reports nothing for an image that never appeared', () => {
    const log = updateLog([d => d.getText('content').insert(0, 'plain text')])
    expect(findFileIdsInHistory(log, [IMG]).size).toBe(0)
  })

  it('handles an empty log and an empty candidate list', () => {
    expect(findFileIdsInHistory([], [IMG]).size).toBe(0)
    expect(findFileIdsInHistory(updateLog([d => d.getText('content').insert(0, IMG)]), []).size).toBe(0)
  })
})

describe('resolveImageGcRetentionDays', () => {
  it('defaults when unset or empty; refuses invalid values', () => {
    expect(resolveImageGcRetentionDays({})).toBe(IMAGE_GC_DEFAULT_RETENTION_DAYS)
    expect(resolveImageGcRetentionDays({ NUXT_IMAGE_GC_RETENTION_DAYS: '' })).toBe(IMAGE_GC_DEFAULT_RETENTION_DAYS)
    for (const raw of ['soon', '-3', '1.5']) {
      expect(() => resolveImageGcRetentionDays({ NUXT_IMAGE_GC_RETENTION_DAYS: raw }), raw).toThrow(/NUXT_IMAGE_GC_RETENTION_DAYS: expected an integer ≥ 0/)
    }
  })

  it('accepts a whole number of days, 0 = disabled', () => {
    expect(resolveImageGcRetentionDays({ NUXT_IMAGE_GC_RETENTION_DAYS: '90' })).toBe(90)
    expect(resolveImageGcRetentionDays({ NUXT_IMAGE_GC_RETENTION_DAYS: '0' })).toBe(0)
  })
})

describe('stagingKeyFor', () => {
  it('puts the staging object next to the final key, out of /api/files reach', () => {
    expect(stagingKeyFor('docs/doc12345/AAAAAAAAAAAA.png')).toBe('docs/doc12345/staging/AAAAAAAAAAAA.png')
    expect(stagingKeyFor('workspaces/ws1/knowledge/k1.pdf')).toBe('workspaces/ws1/knowledge/staging/k1.pdf')
  })
})

describe('memberShareOfWorkspaceSlots', () => {
  it('lets one member hold at most half of the free slots (at least one)', () => {
    expect(memberShareOfWorkspaceSlots(1)).toBe(1)
    expect(memberShareOfWorkspaceSlots(2)).toBe(1)
    expect(memberShareOfWorkspaceSlots(5)).toBe(3)
    expect(memberShareOfWorkspaceSlots(500)).toBe(250)
  })
})
