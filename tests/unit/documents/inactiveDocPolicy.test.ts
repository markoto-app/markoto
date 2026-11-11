import { describe, it, expect } from 'vitest'
import { shouldReapDoc, type SweepDocState } from '../../../shared/utils/documents/inactiveDocPolicy'

// Policy function for the inactive-doc sweeper. Wrong decision here =
// permanent data loss (auto-reaping docs a user wanted to keep) or
// unbounded growth (never reaping anon junk). Pin every branch.

const NOW = new Date('2026-04-20T12:00:00Z')

// Produce a Date that's `days` in the past relative to NOW — the cutoff
// is "lastActive < now - ttl*day", so days past the TTL = old-enough to reap.
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

function doc(overrides: Partial<SweepDocState> = {}): SweepDocState {
  return {
    ownerId: null,
    workspaceId: null,
    lastActive: daysAgo(0),
    ...overrides
  }
}

describe('shouldReapDoc', () => {
  describe('anonymous doc (no owner, no workspace)', () => {
    it('reaps when lastActive is older than the TTL', () => {
      const d = doc({ lastActive: daysAgo(200) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(true)
    })

    it('keeps when lastActive is within the TTL window', () => {
      const d = doc({ lastActive: daysAgo(90) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })

    it('keeps an exactly-at-cutoff doc (boundary is strict <)', () => {
      // lastActive === cutoff means "alive for exactly TTL days" — not
      // past it yet. Pin strict-less-than so fresh docs don't get
      // reaped at the boundary millisecond.
      const d = doc({ lastActive: daysAgo(180) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })

    it('reaps a doc one millisecond past the cutoff', () => {
      const d = doc({ lastActive: new Date(daysAgo(180).getTime() - 1) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(true)
    })

    it('brand-new anon doc is never reaped', () => {
      const d = doc({ lastActive: NOW })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })
  })

  describe('owned doc (ownerId !== null) — NEVER reaped', () => {
    it('ignores the TTL for an owned doc, even one 10 years stale', () => {
      // Core of the new policy. An authenticated user's archival doc
      // stays around until they explicitly delete it. A ten-year-old
      // draft must still not be auto-reaped.
      const d = doc({ ownerId: 42, lastActive: daysAgo(365 * 10) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })

    it('owned + workspace doc stays (both pins apply)', () => {
      const d = doc({ ownerId: 42, workspaceId: 'ws1', lastActive: daysAgo(9999) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })

    it('owned fresh doc stays', () => {
      const d = doc({ ownerId: 42, lastActive: NOW })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })
  })

  describe('workspace-attached doc — NEVER reaped', () => {
    it('workspace + anon (no owner) doc stays, even if very stale', () => {
      // Edge case: a doc with ownerId=null but attached to a workspace.
      // Not a flow we currently produce, but defensively: the workspace
      // attachment alone is an organisation signal that overrides the
      // anon-TTL rule.
      const d = doc({ workspaceId: 'ws1', lastActive: daysAgo(9999) })
      expect(shouldReapDoc(d, NOW, 180)).toBe(false)
    })
  })

  describe('TTL disable', () => {
    it('TTL = 0 disables sweeping entirely (never reaps anything)', () => {
      const d = doc({ lastActive: daysAgo(9999) })
      expect(shouldReapDoc(d, NOW, 0)).toBe(false)
    })

    it('TTL < 0 is treated as disabled', () => {
      const d = doc({ lastActive: daysAgo(9999) })
      expect(shouldReapDoc(d, NOW, -1)).toBe(false)
    })
  })

  describe('regression — old two-TTL behaviour is gone', () => {
    it('owned docs are NOT reaped under any positive TTL', () => {
      // Regression guard: pre-policy-change, owned docs were reaped
      // after `inactiveDocOwnedTtlDays` (365 by default). That field is
      // removed; owned docs must stay forever regardless of ttl value.
      for (const ttl of [1, 30, 180, 365, 3650]) {
        const d = doc({ ownerId: 42, lastActive: daysAgo(ttl + 100) })
        expect(shouldReapDoc(d, NOW, ttl), `ttl=${ttl}`).toBe(false)
      }
    })
  })
})
