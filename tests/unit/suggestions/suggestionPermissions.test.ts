import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideSuggestionAccess, type ActorState, type DocState, type SuggestionPolicyState, type TokenDecision } from '../../../shared/utils/documents/docPermissions'

// The write level of a connection: full, suggest-only or read-only, from
// the token decision and the document's suggestion settings.

const doc = (over: Partial<DocState> = {}): DocState => ({ ownerId: 1, workspaceId: 'ws', accessMode: 'private', ...over })
const actor = (over: Partial<ActorState> = {}): ActorState => ({ userId: 2, workspaceRole: 'editor', ...over })
const policy = (over: Partial<SuggestionPolicyState> = {}): SuggestionPolicyState => ({ required: false, exemptRoles: [], viewersMaySuggest: false, ...over })
const writable: TokenDecision = { outcome: 'allow', readOnly: false }
const readable: TokenDecision = { outcome: 'allow', readOnly: true }

const FULL = { readOnly: false, suggestOnly: false }
const SUGGEST = { readOnly: false, suggestOnly: true }
const READ = { readOnly: true, suggestOnly: false }

describe('decideSuggestionAccess', () => {
  it('refuses everything when the token was not granted', () => {
    for (const outcome of ['forbidden', 'password-required'] as const) {
      expect(decideSuggestionAccess(doc(), actor(), policy({ required: true }), { outcome, readOnly: true })).toEqual(READ)
    }
  })

  it('leaves writers editing when suggestions are not required', () => {
    expect(decideSuggestionAccess(doc(), actor(), policy(), writable)).toEqual(FULL)
  })

  it('makes every non-exempt writer suggest when required', () => {
    expect(decideSuggestionAccess(doc(), actor(), policy({ required: true }), writable)).toEqual(SUGGEST)
  })

  it('never makes the owner suggest', () => {
    expect(decideSuggestionAccess(doc(), actor({ userId: 1, workspaceRole: null }), policy({ required: true }), writable)).toEqual(FULL)
  })

  it('does not treat an owner with suspended access (SSO) as owner', () => {
    expect(decideSuggestionAccess(doc({ ownerAccessSuspended: true }), actor({ userId: 1, workspaceRole: 'editor' }), policy({ required: true }), writable)).toEqual(SUGGEST)
  })

  it('keeps exempt workspace roles editing, only the listed ones', () => {
    const p = policy({ required: true, exemptRoles: ['admin'] })
    expect(decideSuggestionAccess(doc(), actor({ workspaceRole: 'admin' }), p, writable)).toEqual(FULL)
    expect(decideSuggestionAccess(doc(), actor({ workspaceRole: 'editor' }), p, writable)).toEqual(SUGGEST)
    expect(decideSuggestionAccess(doc(), actor({ workspaceRole: 'editor' }), policy({ required: true, exemptRoles: ['admin', 'editor'] }), writable)).toEqual(FULL)
  })

  it('never exempts guests, open-edit visitors or anonymous writers', () => {
    const p = policy({ required: true, exemptRoles: ['admin', 'editor'] })
    expect(decideSuggestionAccess(doc(), actor({ workspaceRole: 'editor', isGuest: true }), p, writable)).toEqual(SUGGEST)
    expect(decideSuggestionAccess(doc({ accessMode: 'open-edit' }), actor({ workspaceRole: null }), p, writable)).toEqual(SUGGEST)
    expect(decideSuggestionAccess(doc({ accessMode: 'open-edit' }), actor({ userId: null, workspaceRole: null }), p, writable)).toEqual(SUGGEST)
  })

  it('lets signed-in viewers suggest when allowed, never anonymous ones', () => {
    const p = policy({ viewersMaySuggest: true })
    expect(decideSuggestionAccess(doc(), actor({ workspaceRole: 'viewer' }), p, readable)).toEqual(SUGGEST)
    expect(decideSuggestionAccess(doc(), actor({ userId: null, workspaceRole: null }), p, readable)).toEqual(READ)
  })

  it('keeps viewers read-only when the document does not allow viewer suggestions', () => {
    expect(decideSuggestionAccess(doc(), actor({ workspaceRole: 'viewer' }), policy(), readable)).toEqual(READ)
  })
})

// ---- suggestMode / mustSuggest: the AI and MCP use the same rule ----

const h = vi.hoisted(() => ({ preference: false }))
vi.mock('../../../server/repos/users', () => ({ getAiSuggestEdits: vi.fn(async () => h.preference) }))

const { sessionSuggestMode, withSuggestNote } = await import('../../../server/utils/agentic/sessions/suggestMode')
const { mustSuggest, suggestionAccessOf } = await import('../../../server/utils/suggestions/suggestionAccess')

const scope = (userId: number): never => Object.assign(Object.create(null), { userId }) as never

const row = (over: Record<string, unknown> = {}): never => {
  const r: Record<string, unknown> = {
    ownerId: 1, workspaceId: 'ws', accessMode: 'private', ownerAccessSuspended: false, workspaceRole: 'editor', isGuest: false,
    suggestionPolicy: { required: false, exemptRoles: [], viewersMaySuggest: false }, ...over
  }
  return r as never
}

describe('mustSuggest + suggestionAccessOf', () => {
  it('follows the document policy for a person acting through the AI or MCP', () => {
    expect(mustSuggest(row(), 2)).toBe(false)
    expect(mustSuggest(row({ suggestionPolicy: { required: true, exemptRoles: [], viewersMaySuggest: false } }), 2)).toBe(true)
    expect(mustSuggest(row({ suggestionPolicy: { required: true, exemptRoles: ['editor'], viewersMaySuggest: false } }), 2)).toBe(false)
  })

  it('reports a viewer as read-only through suggestionAccessOf', () => {
    const r = row({ workspaceRole: 'viewer' })
    expect(suggestionAccessOf(r, { ownerId: 1, workspaceId: 'ws', accessMode: 'private' }, { userId: 2, workspaceRole: 'viewer' })).toEqual({ readOnly: true, suggestOnly: false })
  })
})

describe('sessionSuggestMode', () => {
  beforeEach(() => {
    h.preference = false
  })

  it('forces suggestions when the document requires them, whatever was asked', async () => {
    const r = row({ suggestionPolicy: { required: true, exemptRoles: [], viewersMaySuggest: false } })
    expect(await sessionSuggestMode(r, scope(2), false)).toEqual({ forced: true })
  })

  it('uses the prompt bar switch first, then the user setting', async () => {
    expect(await sessionSuggestMode(row(), scope(2), true)).toEqual({ forced: false })
    h.preference = true
    expect(await sessionSuggestMode(row(), scope(2), undefined)).toEqual({ forced: false })
    expect(await sessionSuggestMode(row(), scope(2), false)).toBeNull()
    h.preference = false
    expect(await sessionSuggestMode(row(), scope(2), undefined)).toBeNull()
  })
})

describe('withSuggestNote', () => {
  it('leaves the prompt alone outside suggestion mode and appends the note inside it', () => {
    expect(withSuggestNote('Fix it', null)).toBe('Fix it')
    const p = withSuggestNote('Fix it', { forced: false })
    expect(p.startsWith('Fix it\n\n<suggestion_mode>')).toBe(true)
    expect(p).toContain('recorded as suggestions')
  })
})
