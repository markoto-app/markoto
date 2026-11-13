import { describe, it, expect } from 'vitest'
import { system, type DocAccess, type UserScope, type WorkspaceAccess } from '../../../server/repos/proofs'
import {
  __mintAdminActor,
  __mintDocAccess,
  __mintUserScope,
  __mintWorkspaceAccess,
  __userActor
} from '../../../server/repos/proofs/testing'
import { adminAs, docWith } from '../../helpers/access'

// Capability proofs (server/repos/proofs/mint.ts): repo functions take them
// instead of bare ids, so these properties are what tenancy rests on,
// construction is closed, levels imply exactly what they should, a proof
// is immutable, and minting fails closed.

const alice = __userActor(1)

describe('construction is closed', () => {
  it('the constructors refuse anything but the module-private token', () => {
    const doc = __mintDocAccess(alice, 'd1', ['view'], 'view')
    const ws = __mintWorkspaceAccess(alice, 'w1', 'viewer', 'member')
    const self = __mintUserScope(1)
    const admin = __mintAdminActor(1)
    for (const proof of [doc, ws, self, admin, system('test-harness')]) {
      const Ctor = proof.constructor as new (...args: unknown[]) => unknown
      // Even a symbol with the same description is a different symbol.
      expect(() => new Ctor(Symbol('access-proof'), 'd1', alice, ['manage'])).toThrow(/minted by server\/utils\/access/)
    }
  })

  it('proofs are frozen: the id and actor cannot be swapped after minting', () => {
    const doc = __mintDocAccess(alice, 'd1', ['view'], 'view')
    expect(Object.isFrozen(doc)).toBe(true)
    expect(() => {
      (doc as unknown as { docId: string }).docId = 'd2'
    }).toThrow(TypeError)
    expect(doc.docId).toBe('d1')
  })

  it('refuses an empty object id', () => {
    expect(() => __mintDocAccess(alice, '', ['view'], 'view')).toThrow(/document id/)
    expect(() => __mintWorkspaceAccess(alice, '', 'admin', 'admin')).toThrow(/workspace id/)
    expect(() => __mintUserScope(0)).toThrow(/user id/)
  })

  it('only named system actors exist', () => {
    expect(system('test-harness').actor).toEqual({ kind: 'system', name: 'test-harness' })
    expect(() => system('made-up' as Parameters<typeof system>[0])).toThrow(/unknown system actor/)
  })
})

describe('document levels', () => {
  it('manage implies edit, write and view, but not share or delete', () => {
    const p = docWith('d1', ['manage'])
    expect(['view', 'write', 'edit', 'manage'].every(l => p.allows(l as 'view'))).toBe(true)
    expect(p.allows('share')).toBe(false)
    expect(p.allows('delete')).toBe(false)
  })

  it('share implies view only; write implies view only; delete implies nothing else', () => {
    const share = docWith('d1', ['share'])
    expect([share.allows('view'), share.allows('write')]).toEqual([true, false])
    const write = docWith('d1', ['write'])
    expect([write.allows('view'), write.allows('edit')]).toEqual([true, false])
    const del = docWith('d1', ['delete'])
    expect([del.allows('delete'), del.allows('view')]).toEqual([true, false])
  })

  it('minting fails closed when the need was not granted', () => {
    expect(() => __mintDocAccess(alice, 'd1', ['view'], 'write')).toThrow(/write was not granted/)
    expect(() => __mintDocAccess(alice, 'd1', [], 'view')).toThrow()
  })
})

describe('workspace levels', () => {
  it.each([
    ['viewer', [true, false, false]],
    ['editor', [true, true, false]],
    ['admin', [true, true, true]]
  ] as const)('%s', (role, want) => {
    const p = __mintWorkspaceAccess(alice, 'w1', role, 'member')
    expect([p.allows('member'), p.allows('editor'), p.allows('admin')]).toEqual(want)
  })

  it('minting fails closed below the needed level', () => {
    expect(() => __mintWorkspaceAccess(alice, 'w1', 'editor', 'admin')).toThrow(/does not satisfy admin/)
  })
})

describe('actors', () => {
  it('a user scope knows whether the user acts for themselves', () => {
    expect(__mintUserScope(5).isSelf).toBe(true)
    expect(__mintAdminActor(1).user(5).isSelf).toBe(false)
    expect(system('test-harness').user(5).isSelf).toBe(false)
    // A job carrying out the user's own request records the user as actor.
    expect(system('test-harness').actingFor(5).actor).toEqual({ kind: 'user', userId: 5 })
  })

  it('elevated actors derive proofs that record them as the actor', () => {
    const admin = adminAs(9)
    const doc = admin.doc('d1')
    expect(doc.actor).toEqual({ kind: 'admin', userId: 9 })
    expect(['view', 'write', 'edit', 'manage', 'share', 'delete'].every(l => doc.allows(l as 'view'))).toBe(true)
    expect(admin.workspace('w1').allows('admin')).toBe(true)
    expect(system('test-harness').doc('d1').actor).toEqual({ kind: 'system', name: 'test-harness' })
  })
})

describe('types', () => {
  it('the compiler refuses forged and too-weak proofs (checked by typecheck:tests)', () => {
    const view = __mintDocAccess(alice, 'd1', ['view'], 'view')
    const manage = __mintDocAccess(alice, 'd1', ['manage'], 'manage')
    const editorWs = __mintWorkspaceAccess(alice, 'w1', 'editor', 'editor')

    // A stronger proof satisfies a weaker need.
    const viewFromManage: DocAccess<'view'> = manage
    const writeFromManage: DocAccess<'write'> = manage
    const memberFromEditor: WorkspaceAccess<'member'> = editorWs

    // @ts-expect-error a view proof is not a write proof
    const writeFromView: DocAccess<'write'> = view
    // @ts-expect-error manage does not imply delete
    const deleteFromManage: DocAccess<'delete'> = manage
    // @ts-expect-error an editor's workspace proof is not an admin proof
    const adminFromEditor: WorkspaceAccess<'admin'> = editorWs
    // @ts-expect-error a workspace proof is not a document proof
    const docFromWs: DocAccess<'view'> = editorWs
    // @ts-expect-error an object literal cannot pose as a document proof
    const forgedDoc: DocAccess<'view'> = { docId: 'd1', actor: alice, allows: () => true }
    // @ts-expect-error an object literal cannot pose as a user scope
    const forgedSelf: UserScope = { userId: 1, actor: alice, isSelf: true }
    // @ts-expect-error a bare id is not a proof
    const bareId: DocAccess<'view'> = 'd1'

    expect([viewFromManage, writeFromManage, memberFromEditor, writeFromView, deleteFromManage, adminFromEditor, docFromWs, forgedDoc, forgedSelf, bareId]).toHaveLength(10)
  })
})
