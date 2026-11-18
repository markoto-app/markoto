import type { DocRow, FolderRow } from '~/utils/explorer/model'

// Rows for the explorer composable tests.

export function folder(id: string, parentId: string | null = null, name = `Folder ${id}`): FolderRow {
  return { folderId: id, parentId, name, docCount: 0, updatedAt: '2026-01-01T00:00:00Z' }
}

export function doc(id: string, folderId: string | null = null, title = `Doc ${id}`): DocRow {
  return {
    docId: id,
    title,
    description: '',
    language: 'en',
    accessMode: 'private',
    wordCount: 0,
    folderId,
    ownerId: 1,
    ownerName: 'Alice',
    isOwner: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastActive: '2026-01-01T00:00:00Z'
  }
}
