import { describe, it, expect } from 'vitest'
import {
  categoryOf,
  isExpandable,
  expansionToggleLabelKey,
  type ActivityLike,
  type ActivityAction
} from '../../app/utils/activityFeedHelpers'

function entry(overrides: Partial<ActivityLike> & { action: ActivityAction }): ActivityLike {
  return { userName: 'Alice', metadata: null, ...overrides }
}

// --- categoryOf -----------------------------------------------------------

describe('categoryOf', () => {
  it('classifies edits', () => {
    expect(categoryOf(entry({ action: 'edit' }))).toBe('edits')
  })

  it('classifies every comment.* variant under comments', () => {
    const variants: ActivityAction[] = [
      'comment.added', 'comment.replied', 'comment.resolved', 'comment.reopened', 'comment.deleted'
    ]
    for (const a of variants) {
      expect(categoryOf(entry({ action: a }))).toBe('comments')
    }
  })

  it('classifies title.changed + theme.changed under meta', () => {
    expect(categoryOf(entry({ action: 'title.changed' }))).toBe('meta')
    expect(categoryOf(entry({ action: 'theme.changed' }))).toBe('meta')
  })

  it('classifies restore under meta (no dedicated chip yet)', () => {
    // restore is rare per-doc; lumping it with the other meta-level
    // doc events keeps the chip count manageable. Pin the choice
    // so a future "Restores" chip lands as a deliberate UI change.
    expect(categoryOf(entry({ action: 'restore' }))).toBe('meta')
  })

  it('classifies ai.tool under ai', () => {
    // The ai.tool action implies AI authorship, but the rule lives
    // in the userName check (see next test). We don't rely on the
    // action alone, so test the AI-author rule explicitly.
    expect(categoryOf(entry({ action: 'ai.tool', userName: 'AI Assistant' }))).toBe('ai')
  })

  it('routes ANY action by AI Assistant to ai (cross-cutting rule)', () => {
    // This is the rule that powers the AI filter chip — every row
    // the AI authored converges there, regardless of action kind.
    expect(categoryOf(entry({ action: 'edit', userName: 'AI Assistant' }))).toBe('ai')
    expect(categoryOf(entry({ action: 'comment.added', userName: 'AI Assistant' }))).toBe('ai')
    expect(categoryOf(entry({ action: 'theme.changed', userName: 'AI Assistant' }))).toBe('ai')
    expect(categoryOf(entry({ action: 'ai.tool', userName: 'AI Assistant' }))).toBe('ai')
  })

  it('classifies join + leave under all (no dedicated bucket)', () => {
    // Defensive — these are rare and don't deserve their own chip.
    // Pin the behavior so a future "Sessions" chip lands as a
    // deliberate UI change, not a silent accident.
    expect(categoryOf(entry({ action: 'join' }))).toBe('all')
    expect(categoryOf(entry({ action: 'leave' }))).toBe('all')
  })

  it('routes anonymous edit (userName=null) to edits', () => {
    expect(categoryOf(entry({ action: 'edit', userName: null }))).toBe('edits')
  })

  it('does NOT match a userName like "AI Assistant " (trailing space) — exact equality only', () => {
    // The rule is value equality on userName, not a fuzzy match.
    // A different identity that happens to start with "AI Assistant"
    // shouldn't accidentally hijack the AI bucket.
    expect(categoryOf(entry({ action: 'edit', userName: 'AI Assistant ' }))).toBe('edits')
    expect(categoryOf(entry({ action: 'edit', userName: 'ai assistant' }))).toBe('edits')
  })
})

// --- isExpandable ---------------------------------------------------------

describe('isExpandable', () => {
  it('makes edit rows expandable (diff drawer)', () => {
    expect(isExpandable(entry({ action: 'edit' }))).toBe(true)
  })

  it('makes every comment.* variant expandable (thread drawer)', () => {
    const variants: ActivityAction[] = [
      'comment.added', 'comment.replied', 'comment.resolved', 'comment.reopened', 'comment.deleted'
    ]
    for (const a of variants) {
      expect(isExpandable(entry({ action: a }))).toBe(true)
    }
  })

  it('makes ai.tool rows expandable ONLY when metadata.kind matches', () => {
    // Defensive: pre-feature ai.tool rows that lost their metadata
    // shouldn't show an empty drawer. Pin the gate.
    expect(isExpandable(entry({ action: 'ai.tool', metadata: { kind: 'ai.tool' } }))).toBe(true)
    expect(isExpandable(entry({ action: 'ai.tool', metadata: null }))).toBe(false)
    expect(isExpandable(entry({ action: 'ai.tool', metadata: { kind: 'something-else' } }))).toBe(false)
  })

  it('does NOT make theme.changed / title.changed expandable yet', () => {
    expect(isExpandable(entry({ action: 'theme.changed' }))).toBe(false)
    expect(isExpandable(entry({ action: 'title.changed' }))).toBe(false)
  })

  it('makes restore rows expandable (diff drawer reuses Tier 1 machinery)', () => {
    // The restore endpoint stamps yjsDocIdBefore + yjsDocIdAfter on
    // the restore activity row, so the existing diff drawer can
    // compute "what content was removed / re-added by this restore"
    // without any new endpoint code. Pin the affordance.
    expect(isExpandable(entry({ action: 'restore' }))).toBe(true)
  })

  it('does NOT make join / leave expandable', () => {
    expect(isExpandable(entry({ action: 'join' }))).toBe(false)
    expect(isExpandable(entry({ action: 'leave' }))).toBe(false)
  })
})

// --- expansionToggleLabelKey ---------------------------------------------

describe('expansionToggleLabelKey', () => {
  it('returns the diff key for edit rows', () => {
    expect(expansionToggleLabelKey(entry({ action: 'edit' }), false)).toBe('activity.diff.viewChange')
    expect(expansionToggleLabelKey(entry({ action: 'edit' }), true)).toBe('activity.diff.hideChange')
  })

  it('returns the comment-context key for every comment.* variant', () => {
    expect(expansionToggleLabelKey(entry({ action: 'comment.added' }), false)).toBe('activity.commentContext.view')
    expect(expansionToggleLabelKey(entry({ action: 'comment.replied' }), false)).toBe('activity.commentContext.view')
    expect(expansionToggleLabelKey(entry({ action: 'comment.deleted' }), true)).toBe('activity.commentContext.hide')
  })

  it('returns the ai-tool key for ai.tool rows', () => {
    expect(expansionToggleLabelKey(entry({ action: 'ai.tool' }), false)).toBe('activity.aiTool.view')
    expect(expansionToggleLabelKey(entry({ action: 'ai.tool' }), true)).toBe('activity.aiTool.hide')
  })

  it('returns null for non-expandable kinds (no affordance label)', () => {
    expect(expansionToggleLabelKey(entry({ action: 'theme.changed' }), false)).toBeNull()
    expect(expansionToggleLabelKey(entry({ action: 'join' }), false)).toBeNull()
  })

  it('reuses the diff-drawer label for restore rows', () => {
    expect(expansionToggleLabelKey(entry({ action: 'restore' }), false)).toBe('activity.diff.viewChange')
    expect(expansionToggleLabelKey(entry({ action: 'restore' }), true)).toBe('activity.diff.hideChange')
  })
})
