import { buildFolderTree, folderPathOf, type DocRow, type FolderNode, type FolderRow } from './model'

// Folders with their documents as one tree, for the editor's left panel
// (the explorer shows one folder at a time instead). Pure.

export type DocTreeEntry
  = | { kind: 'folder', folder: FolderRow, children: DocTreeEntry[] }
    | { kind: 'doc', doc: DocRow }

function byTitle(a: DocRow, b: DocRow): number {
  return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })
}

/**
 * Folders first (by name, as in the explorer), then the documents, by
 * title. A document whose folder isn't among `folders` (not loaded, or
 * just moved) sits at the root rather than disappearing.
 */
export function buildDocTree(folders: readonly FolderRow[], docs: readonly DocRow[]): DocTreeEntry[] {
  const known = new Set(folders.map(f => f.folderId))
  const docsIn = new Map<string | null, DocRow[]>()
  for (const doc of docs) {
    const at = doc.folderId !== null && known.has(doc.folderId) ? doc.folderId : null
    docsIn.set(at, [...(docsIn.get(at) ?? []), doc])
  }
  const docEntries = (at: string | null): DocTreeEntry[] =>
    [...(docsIn.get(at) ?? [])].sort(byTitle).map(doc => ({ kind: 'doc', doc }))
  const folderEntry = (node: FolderNode): DocTreeEntry => ({
    kind: 'folder',
    folder: node.folder,
    children: [...node.children.map(folderEntry), ...docEntries(node.folder.folderId)]
  })
  return [...buildFolderTree(folders).map(folderEntry), ...docEntries(null)]
}

/** Ids of the folders a document sits in, outermost first (empty at the root or when unknown). */
export function folderIdsAbove(folders: readonly FolderRow[], folderId: string | null): string[] {
  return folderPathOf(folders, folderId).map(f => f.folderId)
}
