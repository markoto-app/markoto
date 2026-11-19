// How the project context reaches a session: the setup resolves it for the
// initiator (and offers the context tools only when something applies), and
// the taint gate treats context written by other people like text the
// session read from another document.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deliberatelyInvalid } from '../../helpers/fixtures'
import * as Y from 'yjs'

import { resolveSessionWorkspace } from '../../../server/utils/agentic/sessions/sessionSetup'
import { buildSessionGuard } from '../../../server/utils/agentic/sessionGuard'
import { resolveProjectContext } from '../../../server/utils/documents/projectContext'
import { proveWorkspaceAccess } from '../../../server/utils/access/workspaceAccess'
import { proveDocMembership } from '../../../server/utils/access/docProof'
import { listMembers } from '../../../server/repos/workspaceMembers'
import { listReadyKnowledgeBrief } from '../../../server/repos/knowledge'
import { getDoc } from '../../../server/repos/documents'
import { countOtherWorkspaceEditors, hasForeignContentActivity } from '../../../server/repos/docProvenance'
import { ALL_TOOL_DECLARATIONS, CONTEXT_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../../server/utils/ai/tools/registry'
import { docAs, wsRole } from '../../helpers/access'

vi.mock('../../../server/utils/documents/projectContext', () => ({ resolveProjectContext: vi.fn() }))
vi.mock('../../../server/utils/access/workspaceAccess', () => ({ proveWorkspaceAccess: vi.fn() }))
vi.mock('../../../server/utils/access/docProof', () => ({ proveDocMembership: vi.fn() }))
vi.mock('../../../server/repos/workspaceMembers', () => ({ listMembers: vi.fn() }))
vi.mock('../../../server/repos/knowledge', () => ({ listReadyKnowledgeBrief: vi.fn() }))
vi.mock('../../../server/repos/documents', () => ({ getDoc: vi.fn() }))
vi.mock('../../../server/repos/docProvenance', () => ({
  countOtherWorkspaceEditors: vi.fn(),
  hasForeignContentActivity: vi.fn()
}))

const names = (decls: Array<{ name: string }>) => decls.map(d => d.name)

beforeEach(() => {
  vi.resetAllMocks()
})

const ctxEntry = (docId: string) => ({ docId, title: docId, source: 'all' as const, body: `Facts of ${docId}.`, access: docAs(docId, 7) })

describe('resolveSessionWorkspace: project context', () => {
  it('offers the context tools and the prompt block when context documents apply', async () => {
    vi.mocked(resolveProjectContext).mockResolvedValue({ entries: [ctxEntry('bible'), ctxEntry('glossary')] as never, omitted: 1 })
    const ws = await resolveSessionWorkspace(null, 7, docAs('cur', 7))
    expect(ws.contextDocIds).toEqual(['bible', 'glossary'])
    expect(ws.projectContextBlock).toContain('Facts of bible.')
    expect(ws.projectContextBlock).toContain('1 more context document')
    expect(names(ws.toolDeclarations)).toEqual(names([...ALL_TOOL_DECLARATIONS, ...CONTEXT_TOOL_DECLARATIONS]))
    expect(ws.workspaceId).toBeNull()
  })

  it('leaves the context tools out when nothing applies', async () => {
    vi.mocked(resolveProjectContext).mockResolvedValue({ entries: [], omitted: 0 })
    const ws = await resolveSessionWorkspace(null, 7, docAs('cur', 7))
    expect(ws.projectContextBlock).toBe('')
    expect(ws.contextDocIds).toEqual([])
    expect(names(ws.toolDeclarations)).toEqual(names(ALL_TOOL_DECLARATIONS))
  })

  it('a failing resolution leaves the session without context instead of failing it', async () => {
    vi.mocked(resolveProjectContext).mockRejectedValue(new Error('db down'))
    const ws = await resolveSessionWorkspace(null, 7, docAs('cur', 7))
    expect(ws.projectContextBlock).toBe('')
    expect(ws.contextDocIds).toEqual([])
    expect(names(ws.toolDeclarations)).toEqual(names(ALL_TOOL_DECLARATIONS))
  })

  it('a caller who is no workspace member gets no workspace but keeps the context', async () => {
    vi.mocked(resolveProjectContext).mockResolvedValue({ entries: [ctxEntry('bible')] as never, omitted: 0 })
    vi.mocked(proveWorkspaceAccess).mockResolvedValue(null)
    const ws = await resolveSessionWorkspace('ws1', 7, docAs('cur', 7))
    expect(ws.workspaceAccess).toBeNull()
    expect(ws.knowledgeFiles).toEqual([])
    expect(ws.contextDocIds).toEqual(['bible'])
  })

  it('combines workspace knowledge tools and context tools, listing members without guests', async () => {
    vi.mocked(resolveProjectContext).mockResolvedValue({ entries: [ctxEntry('bible')] as never, omitted: 0 })
    vi.mocked(proveWorkspaceAccess).mockResolvedValue(wsRole('ws1', 7, 'editor') as never)
    vi.mocked(listMembers).mockResolvedValue([
      { userId: 7, name: 'Maya', role: 'editor' },
      { userId: 8, name: 'Guest', role: 'guest' }
    ] as never)
    vi.mocked(listReadyKnowledgeBrief).mockResolvedValue([{ knowledgeId: 'k1', filename: 'a.pdf', uploaderId: 7 }] as never)
    const ws = await resolveSessionWorkspace('ws1', 7, docAs('cur', 7))
    expect(ws.workspaceId).toBe('ws1')
    expect(ws.members).toEqual([{ userId: 7, name: 'Maya' }])
    expect(ws.exposeKnowledgeTools).toBe(true)
    expect(names(ws.toolDeclarations)).toEqual(names([...ALL_TOOL_DECLARATIONS, ...KNOWLEDGE_TOOL_DECLARATIONS, ...CONTEXT_TOOL_DECLARATIONS]))
    expect(ws.contextDocIds).toEqual(['bible'])
  })
})

describe('buildSessionGuard: project context taint', () => {
  const channel = deliberatelyInvalid({ requestConfirmation: vi.fn() })
  const base = { docId: 'cur', initiatorUserId: 7, workspaceAccess: null, ydoc: new Y.Doc(), channel, invokerText: [], knowledgeFiles: [] }

  /** Which documents count as solo for user 7: owned, private, no foreign edits. */
  function soloDocs(solo: Record<string, boolean>) {
    vi.mocked(proveDocMembership).mockImplementation(async (_u, docId) => (docId in solo ? deliberatelyInvalid({ access: docAs(docId, 7) }) : null))
    vi.mocked(getDoc).mockImplementation(async (access) => {
      const id = (access as { docId: string }).docId
      return deliberatelyInvalid({ ownerId: 7, accessMode: 'private', workspaceId: null, docId: id })
    })
    vi.mocked(hasForeignContentActivity).mockImplementation(async access => !solo[(access as { docId: string }).docId])
    vi.mocked(countOtherWorkspaceEditors).mockResolvedValue(0)
  }

  it('starts untainted when every context document is the initiator\'s own', async () => {
    soloDocs({ cur: true, bible: true })
    const guard = await buildSessionGuard({ ...base, contextDocIds: ['bible'] })
    expect(guard.taintReasons).toEqual([])
  })

  it('starts tainted when a context document was shaped by other people', async () => {
    soloDocs({ cur: true, bible: false })
    const guard = await buildSessionGuard({ ...base, contextDocIds: ['bible'] })
    expect(guard.taintReasons).toContain('project context written by other people')
  })

  it('a context document the initiator cannot even prove membership of counts as shared', async () => {
    soloDocs({ cur: true })
    const guard = await buildSessionGuard({ ...base, contextDocIds: ['bible'] })
    expect(guard.taintReasons).toContain('project context written by other people')
  })

  it('no context documents never taint on their own', async () => {
    soloDocs({ cur: true })
    const guard = await buildSessionGuard({ ...base })
    expect(guard.taintReasons).toEqual([])
  })

  it('a shared session document taints regardless of the context', async () => {
    soloDocs({ cur: false, bible: true })
    const guard = await buildSessionGuard({ ...base, contextDocIds: ['bible'] })
    expect(guard.taintReasons).toContain('the shared document')
  })
})
