import { describe, expect, it } from 'vitest'
import {
  buildFolderTree,
  canDropInto,
  docItem,
  explorerPermissions,
  folderItem,
  folderPathOf,
  freeFolderName,
  menuActions,
  subtreeIds,
  type DocRow,
  type FolderRow
} from '../../../app/utils/explorer/model'

const f = (folderId: string, parentId: string | null, name = folderId): FolderRow => ({ folderId, parentId, name, docCount: 0, updatedAt: '' })
const d = (docId: string, folderId: string | null, isOwner = false): DocRow => ({
  docId, title: docId, description: '', language: 'en', accessMode: 'private', wordCount: 0, folderId,
  ownerId: 1, ownerName: null, isOwner, createdAt: '', updatedAt: '', lastActive: ''
})

const rows = [f('a', null, 'Beta'), f('b', 'a'), f('c', 'b'), f('z', null, 'alpha')]

describe('folder tree', () => {
  it('nests rows and sorts siblings by name', () => {
    const tree = buildFolderTree(rows)
    expect(tree.map(n => n.folder.name)).toEqual(['alpha', 'Beta'])
    expect(tree[1]?.children[0]?.children[0]?.folder.folderId).toBe('c')
  })

  it('subtree and path', () => {
    expect([...subtreeIds(rows, 'a')].sort()).toEqual(['a', 'b', 'c'])
    expect(folderPathOf(rows, 'c').map(r => r.folderId)).toEqual(['a', 'b', 'c'])
    expect(folderPathOf(rows, null)).toEqual([])
  })

  it('a free sibling name', () => {
    expect(freeFolderName([f('x', null, 'New folder'), f('y', null, 'new folder (2)')], null, 'New folder')).toBe('New folder (3)')
    expect(freeFolderName([f('x', 'p', 'New folder')], null, 'New folder')).toBe('New folder')
  })
})

describe('drop validity', () => {
  it('refuses a folder into itself or below itself', () => {
    expect(canDropInto(rows, [folderItem(rows[0] as FolderRow)], 'c')).toBe(false)
    expect(canDropInto(rows, [folderItem(rows[0] as FolderRow)], 'a')).toBe(false)
    expect(canDropInto(rows, [folderItem(rows[0] as FolderRow)], 'z')).toBe(true)
  })

  it('refuses a drop where everything already is', () => {
    expect(canDropInto(rows, [docItem(d('d1', 'b'))], 'b')).toBe(false)
    expect(canDropInto(rows, [docItem(d('d1', 'b'))], null)).toBe(true)
    expect(canDropInto(rows, [], null)).toBe(false)
  })
})

describe('context menu matrix', () => {
  const admin = explorerPermissions('admin')
  const editor = explorerPermissions('editor')
  const viewer = explorerPermissions('viewer')
  const flat = (groups: string[][]) => groups.flat()

  it('empty space: create for writers, paste only with something cut, nothing for viewers', () => {
    expect(flat(menuActions(editor, [], { canPaste: false }))).toEqual(['newDocument', 'newFolder', 'import'])
    expect(flat(menuActions(editor, [], { canPaste: true }))).toContain('paste')
    expect(menuActions(viewer, [], { canPaste: true })).toEqual([])
  })

  it('a document: editors rename and move, only the owner or an admin shares and deletes', () => {
    const someoneElses = docItem(d('d1', null))
    expect(flat(menuActions(editor, [someoneElses], { canPaste: false }))).toEqual(['open', 'openNewTab', 'rename', 'moveTo', 'cut', 'duplicate', 'copyLink'])
    expect(flat(menuActions(admin, [someoneElses], { canPaste: false }))).toContain('delete')
    expect(flat(menuActions(viewer, [someoneElses], { canPaste: false }))).toEqual(['open', 'openNewTab', 'copyLink'])
    expect(flat(menuActions(viewer, [docItem(d('d2', null, true))], { canPaste: false }))).toEqual(expect.arrayContaining(['rename', 'share', 'delete']))
  })

  it('a folder: viewers only open and copy the link', () => {
    const folder = folderItem(f('x', null))
    expect(flat(menuActions(viewer, [folder], { canPaste: false }))).toEqual(['open', 'openNewTab', 'copyLink'])
    expect(flat(menuActions(editor, [folder], { canPaste: false }))).toEqual(expect.arrayContaining(['newFolder', 'rename', 'moveTo', 'delete']))
  })

  it('a selection: delete only when every item may be deleted', () => {
    const mixed = [docItem(d('d1', null)), docItem(d('d2', null, true))]
    expect(flat(menuActions(editor, mixed, { canPaste: false }))).toEqual(['moveTo', 'cut', 'copyLinks'])
    expect(flat(menuActions(admin, mixed, { canPaste: false }))).toEqual(['moveTo', 'cut', 'copyLinks', 'delete'])
  })
})
