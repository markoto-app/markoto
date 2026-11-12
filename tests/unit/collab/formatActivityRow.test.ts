import { describe, it, expect } from 'vitest'
import { formatActivityRow } from '../../../server/utils/ai/tools/activityTools'
import type { ActivityEntry } from '../../../server/repos/activity'

// Per-action rendering for `search_activity_log`'s output. The model
// reads these lines verbatim, so the format has to be tight, faithful,
// and consistent across action types. Every branch is tested so that
// adding a new action / metadata kind is a deliberate change to the
// formatter rather than a silent regression.

const TS_FIXED = new Date('2026-05-02T12:34:56.000Z')
const TS_FIXED_ISO = TS_FIXED.toISOString()

function entry(overrides: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 1,
    docId: 'doc-x',
    userId: 7,
    userName: 'Alice',
    action: 'edit',
    wordCount: null,
    linesAdded: null,
    linesRemoved: null,
    metadata: null,
    yjsDocIdBefore: null,
    yjsDocIdAfter: null,
    actorPrincipal: null,
    actorAvatarSeed: null,
    agentKind: null,
    agentInitiatorUserId: null,
    agentInitiatorName: null,
    agentClientName: null,
    createdAt: TS_FIXED,
    ...overrides
  }
}

describe('formatActivityRow', () => {
  it('always prefixes with [#id ISO action by Author]', () => {
    const out = formatActivityRow(entry({ action: 'edit', linesAdded: 1, linesRemoved: 0 }))
    expect(out.startsWith(`[#1 ${TS_FIXED_ISO} edit by Alice]`)).toBe(true)
  })

  it('falls back to "(anonymous)" when userName is null', () => {
    // AI rows + pre-feature rows + deleted-user attribution (`set
    // null` FK on user delete) all show up as anonymous. Model
    // reading the log shouldn't hallucinate a username.
    const out = formatActivityRow(entry({ userName: null }))
    expect(out).toContain('by (anonymous)')
  })

  describe('edit action', () => {
    it('reports +N/-M lines and word count when present', () => {
      const out = formatActivityRow(entry({
        action: 'edit', linesAdded: 5, linesRemoved: 2, wordCount: 142
      }))
      expect(out).toMatch(/\+5\/-2 lines, 142 words$/)
    })

    it('clamps missing line counts to 0 in the rendered output', () => {
      // ActivityEntry types these as nullable; the renderer coalesces
      // to 0 so the model never sees `null` text. Real rows from the
      // sync-server always carry both, but pre-feature rows or the
      // partial-unique-index dedup race may leave one missing.
      const out = formatActivityRow(entry({
        action: 'edit', linesAdded: 3, linesRemoved: null
      }))
      expect(out).toMatch(/\+3\/-0 lines/)
    })

    it('renders just "edit" when no counts are present', () => {
      const out = formatActivityRow(entry({ action: 'edit' }))
      expect(out).toMatch(/\] edit$/)
    })
  })

  describe('comment.* actions', () => {
    it.each(['comment.added', 'comment.replied', 'comment.resolved', 'comment.reopened', 'comment.deleted'] as const)(
      'renders %s with comment_id + body preview',
      (action) => {
        // The action enum has 5 comment.* values but the metadata
        // discriminator types differ slightly per action. The formatter
        // is duck-typed — it only reads `commentId` + `bodyPreview` —
        // so a single shape covers all five for testing purposes.
        const metadata = { kind: action, commentId: 'c_xyz', bodyPreview: 'Looks good to me' } as unknown as ActivityEntry['metadata']
        const out = formatActivityRow(entry({ action, metadata }))
        expect(out).toContain('comment_id=c_xyz')
        expect(out).toContain('body≈"Looks good to me"')
      }
    )

    it('truncates bodyPreview to 120 chars', () => {
      const long = 'lorem '.repeat(40) // 240 chars
      const out = formatActivityRow(entry({
        action: 'comment.added',
        metadata: { kind: 'comment.added', commentId: 'c_x', bodyPreview: long }
      }))
      // 120 chars: 'lorem ' is 6 chars, so 20 reps = 120 chars
      const expected = 'lorem '.repeat(20)
      expect(out).toContain(`body≈"${expected}"`)
    })
  })

  describe('title.changed', () => {
    it('renders from → to with both quoted', () => {
      const out = formatActivityRow(entry({
        action: 'title.changed',
        metadata: { kind: 'title.changed', from: 'Untitled', to: 'Quarterly Plan' }
      }))
      expect(out).toContain('from "Untitled" → "Quarterly Plan"')
    })
  })

  describe('theme.changed', () => {
    it('renders "theme updated" without trying to read patch content', () => {
      // The metadata is `{ kind: 'theme.changed' }` (no diff captured).
      // The formatter must not reach for a patch field.
      const out = formatActivityRow(entry({
        action: 'theme.changed',
        metadata: { kind: 'theme.changed' }
      }))
      expect(out).toMatch(/theme updated$/)
    })
  })

  describe('ai.tool', () => {
    it('renders web_search with the query', () => {
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        userName: null, // AI rows have no userName
        metadata: { kind: 'ai.tool', tool: 'web_search', query: 'latest gpt-5 pricing' }
      }))
      expect(out).toContain('web_search query="latest gpt-5 pricing"')
    })

    it('renders fetch_url with the url', () => {
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'fetch_url', url: 'https://example.com' }
      }))
      expect(out).toContain('fetch_url url="https://example.com"')
    })

    it('renders generate_image with the prompt', () => {
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'generate_image', prompt: 'A handshake' }
      }))
      expect(out).toContain('generate_image prompt="A handshake"')
    })

    it('renders view_image with the src', () => {
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'view_image', src: '/api/files/abc/x.png' }
      }))
      expect(out).toContain('view_image src="/api/files/abc/x.png"')
    })

    it('renders search_knowledge with the query', () => {
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'search_knowledge', query: 'pricing model' }
      }))
      expect(out).toContain('search_knowledge query="pricing model"')
    })

    it('renders get_knowledge_file with the knowledge_id', () => {
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'get_knowledge_file', knowledgeId: 'k_abc' }
      }))
      expect(out).toContain('get_knowledge_file knowledge_id=k_abc')
    })

    it('truncates long urls / prompts / queries', () => {
      const long = 'x'.repeat(500)
      const out = formatActivityRow(entry({
        action: 'ai.tool',
        metadata: { kind: 'ai.tool', tool: 'web_search', query: long }
      }))
      // web_search caps at 120 chars
      expect(out).toContain(`query="${'x'.repeat(120)}"`)
      expect(out).not.toContain('x'.repeat(121))
    })

    it('falls back to "ai.tool <tool>" for an unknown tool name', () => {
      // Hypothetical future tool — formatter shouldn't crash, just
      // emit the bare name. The metadata union doesn't include this
      // tool so we cast through unknown for testing.
      const metadata = { kind: 'ai.tool', tool: 'hypothetical_tool' } as unknown as ActivityEntry['metadata']
      const out = formatActivityRow(entry({ action: 'ai.tool', metadata }))
      expect(out).toContain('ai.tool hypothetical_tool')
    })
  })

  describe('restore', () => {
    it('renders restored to row #N with frozen timestamp', () => {
      const out = formatActivityRow(entry({
        action: 'restore',
        metadata: {
          kind: 'restore',
          restoredFromActivityId: 42,
          restoredFromTime: '2026-04-30T10:00:00Z'
        }
      }))
      expect(out).toContain('restored to row #42')
      expect(out).toContain('(2026-04-30T10:00:00Z)')
    })

    it('falls back to "?" when restoredFromActivityId is missing', () => {
      // partial / corrupt metadata — formatter must not crash
      const metadata = { kind: 'restore' } as unknown as ActivityEntry['metadata']
      const out = formatActivityRow(entry({ action: 'restore', metadata }))
      expect(out).toContain('restored to row #?')
    })
  })

  describe('join / leave', () => {
    it.each(['join', 'leave'] as const)('renders %s as the bare action label', (action) => {
      const out = formatActivityRow(entry({ action }))
      expect(out).toMatch(new RegExp(`\\] ${action}$`))
    })
  })
})
