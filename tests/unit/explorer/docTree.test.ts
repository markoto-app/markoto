import { describe, it, expect } from 'vitest'
import { buildDocTree, folderIdsAbove, type DocTreeEntry } from '../../../app/utils/explorer/docTree'
import { docOpenTarget, docPath } from '../../../app/utils/explorer/docLinks'
import type { DocRow, FolderRow } from '../../../app/utils/explorer/model'

// The editor's Workspace tab: folders with their documents as one tree.

function folder(id: string, parentId: string | null, name: string): FolderRow {
  return { folderId: id, parentId, name, docCount: 0, updatedAt: '2026-01-01T00:00:00Z' }
}

function doc(id: string, folderId: string | null, title: string): DocRow {
  return {
    docId: id, title, description: '', language: 'en', accessMode: 'private', wordCount: 0, folderId,
    ownerId: 1, ownerName: 'Alice', isOwner: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastActive: '2026-01-01T00:00:00Z'
  }
}

function shape(entries: DocTreeEntry[]): unknown[] {
  return entries.map(e => e.kind === 'folder' ? [`${e.folder.name}/`, shape(e.children)] : e.doc.title)
}

describe('buildDocTree', () => {
  const folders = [folder('f2', null, 'Research'), folder('f1', null, 'Marketing'), folder('f3', 'f2', 'Interviews')]

  it('puts folders first, then documents, each sorted, and nests both', () => {
    const docs = [
      doc('d1', null, 'Roadmap'), doc('d2', 'f2', 'Survey 10'), doc('d3', 'f2', 'Survey 2'),
      doc('d4', 'f3', 'Acme'), doc('d5', null, 'brief'), doc('d6', 'f1', 'Launch')
    ]
    expect(shape(buildDocTree(folders, docs))).toEqual([
      ['Marketing/', ['Launch']],
      ['Research/', [['Interviews/', ['Acme']], 'Survey 2', 'Survey 10']],
      'brief',
      'Roadmap'
    ])
  })

  it('keeps empty folders and shows a document of an unknown folder at the root', () => {
    expect(shape(buildDocTree([folder('f1', null, 'Empty')], [doc('d1', 'gone', 'Orphan')]))).toEqual([['Empty/', []], 'Orphan'])
  })

  it('handles untitled documents and an empty scope', () => {
    expect(shape(buildDocTree([], [doc('d1', null, 'b'), doc('d2', null, '')]))).toEqual(['', 'b'])
    expect(buildDocTree([], [])).toEqual([])
  })

  it('names the folders above a document, outermost first', () => {
    expect(folderIdsAbove(folders, 'f3')).toEqual(['f2', 'f3'])
    expect(folderIdsAbove(folders, null)).toEqual([])
  })
})

describe('doc links', () => {
  it('opens a new tab for Ctrl / Cmd + click and the middle button', () => {
    expect(docOpenTarget({ ctrlKey: true, metaKey: false })).toBe('new-tab')
    expect(docOpenTarget({ ctrlKey: false, metaKey: true })).toBe('new-tab')
    expect(docOpenTarget({ ctrlKey: false, metaKey: false, button: 1 })).toBe('new-tab')
    expect(docOpenTarget({ ctrlKey: false, metaKey: false, button: 0 })).toBe('here')
    expect(docOpenTarget(null)).toBe('here')
  })

  it('builds the document path', () => {
    expect(docPath('abc123')).toBe('/d/abc123')
    expect(docPath('a/b')).toBe('/d/a%2Fb')
  })
})
