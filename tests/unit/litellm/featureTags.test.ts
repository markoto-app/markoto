import { describe, it, expect } from 'vitest'
import {
  FEATURE_TAGS,
  ALL_FEATURE_TAGS,
  TAG_NAMESPACES,
  workspaceTag,
  userTag,
  docTag,
  featureMetadata
} from '../../../server/utils/litellm/featureTags'

// LiteLLM spend-tag construction. Four axes in one metadata payload:
// feature (always), workspace + user + doc (conditional on context).
// Single source of truth — every billable call site uses
// `featureMetadata(...)` rather than hand-rolling tag arrays.

describe('featureTags — namespaces', () => {
  it('TAG_NAMESPACES enumerates every prefix the dashboard recognises', () => {
    expect(TAG_NAMESPACES).toEqual(['feature:', 'workspace:', 'user:', 'doc:'])
  })

  it('every feature tag uses the feature: prefix', () => {
    for (const tag of ALL_FEATURE_TAGS) {
      expect(tag).toMatch(/^feature:/)
    }
  })

  it('workspaceTag / userTag / docTag emit the canonical shape', () => {
    expect(workspaceTag('ws-abc')).toBe('workspace:ws-abc')
    expect(userTag(42)).toBe('user:42')
    expect(docTag('doc-xyz')).toBe('doc:doc-xyz')
  })
})

describe('featureMetadata — multi-axis construction', () => {
  it('emits feature-only when no context provided', () => {
    const md = featureMetadata(FEATURE_TAGS.transcribe)
    expect(md.metadata.tags).toEqual(['feature:transcribe'])
  })

  it('appends workspace + user + doc when all are supplied', () => {
    const md = featureMetadata(FEATURE_TAGS.textLoop, {
      workspaceId: 'ws-1',
      userId: 7,
      docId: 'doc-A'
    })
    expect(md.metadata.tags).toEqual([
      'feature:text-loop',
      'workspace:ws-1',
      'user:7',
      'doc:doc-A'
    ])
  })

  it('skips axes whose context is null/undefined', () => {
    const md = featureMetadata(FEATURE_TAGS.imageGen, {
      workspaceId: null,
      userId: 99
      // docId omitted
    })
    expect(md.metadata.tags).toEqual(['feature:image-gen', 'user:99'])
  })

  it('skips userId when it is zero or negative (defensive — sentinel for "anonymous")', () => {
    // We never bill an unauthenticated user (every billable site
    // requires a session), but a zero would tag spend to a fake
    // "user:0" that an attacker could potentially monitor.
    const md = featureMetadata(FEATURE_TAGS.embeddings, { userId: 0 })
    expect(md.metadata.tags).toEqual(['feature:embeddings'])

    const negMd = featureMetadata(FEATURE_TAGS.embeddings, { userId: -1 })
    expect(negMd.metadata.tags).toEqual(['feature:embeddings'])
  })

  it('order is stable: feature → workspace → user → doc', () => {
    // The dashboard doesn't depend on order today, but a stable
    // shape makes spend-log spot-checks easier.
    const md = featureMetadata(FEATURE_TAGS.dictateTick, {
      docId: 'doc-Z',
      workspaceId: 'ws-Q',
      userId: 1
    })
    expect(md.metadata.tags).toEqual([
      'feature:dictate-tick',
      'workspace:ws-Q',
      'user:1',
      'doc:doc-Z'
    ])
  })
})
