// The explorer's data model, pure: items (folders and documents) with their
// keys, the folder tree built from the server's flat rows, drop validity and
// which actions a person may take on what (mirrors the server's rules; every
// endpoint re-checks).

export interface FolderRow {
  folderId: string
  parentId: string | null
  name: string
  docCount: number
  updatedAt: string
}

export interface DocRow {
  docId: string
  title: string
  description: string
  language: string
  accessMode: string
  wordCount: number
  folderId: string | null
  ownerId: number | null
  ownerName: string | null
  isOwner: boolean
  createdAt: string
  updatedAt: string
  lastActive: string
  snippet?: string
}

export type ExplorerItem
  = | { kind: 'folder', key: string, id: string, label: string, folder: FolderRow }
    | { kind: 'doc', key: string, id: string, label: string, doc: DocRow }

const folderKey = (id: string) => `f:${id}`
const docKey = (id: string) => `d:${id}`

export function folderItem(folder: FolderRow): ExplorerItem {
  return { kind: 'folder', key: folderKey(folder.folderId), id: folder.folderId, label: folder.name, folder }
}

export function docItem(doc: DocRow): ExplorerItem {
  return { kind: 'doc', key: docKey(doc.docId), id: doc.docId, label: doc.title || 'Untitled', doc }
}

export interface FolderNode {
  folder: FolderRow
  children: FolderNode[]
}

/** Nested tree from flat rows, siblings by name. Rows whose parent is missing hang at the root. */
export function buildFolderTree(rows: readonly FolderRow[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>()
  for (const folder of rows) nodes.set(folder.folderId, { folder, children: [] })
  const roots: FolderNode[] = []
  for (const node of nodes.values()) {
    const parent = node.folder.parentId === null ? undefined : nodes.get(node.folder.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: FolderNode[]) => {
    list.sort((a, b) => a.folder.name.localeCompare(b.folder.name, undefined, { sensitivity: 'base', numeric: true }))
    for (const n of list) sort(n.children)
  }
  sort(roots)
  return roots
}

/** The folder and every folder below it. */
export function subtreeIds(rows: readonly FolderRow[], folderId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const r of rows) {
    if (r.parentId === null) continue
    children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.folderId])
  }
  const out = new Set<string>()
  const stack = [folderId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(children.get(id) ?? []))
  }
  return out
}

/** Ancestors of a folder, root first, ending with the folder itself. */
export function folderPathOf(rows: readonly FolderRow[], folderId: string | null): FolderRow[] {
  if (folderId === null) return []
  const byId = new Map(rows.map(r => [r.folderId, r]))
  const path: FolderRow[] = []
  let current = byId.get(folderId)
  while (current && path.length < 64) {
    path.unshift(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return path
}

/**
 * May the dragged items be dropped into `target` (null = the root)? Not a
 * folder into itself or below itself, and not where everything already is.
 */
export function canDropInto(rows: readonly FolderRow[], dragged: readonly ExplorerItem[], target: string | null): boolean {
  if (dragged.length === 0) return false
  let changes = false
  for (const item of dragged) {
    if (item.kind === 'folder') {
      if (target !== null && subtreeIds(rows, item.id).has(target)) return false
      if (item.folder.parentId !== target) changes = true
    } else if (item.doc.folderId !== target) {
      changes = true
    }
  }
  return changes
}

/** A sibling name not taken yet: "New folder", "New folder (2)", … */
export function freeFolderName(rows: readonly FolderRow[], parentId: string | null, base: string): string {
  const taken = new Set(rows.filter(r => r.parentId === parentId).map(r => r.name.toLocaleLowerCase()))
  if (!taken.has(base.toLocaleLowerCase())) return base
  for (let n = 2; n < 1000; n++) {
    const name = `${base} (${n})`
    if (!taken.has(name.toLocaleLowerCase())) return name
  }
  return `${base} (${Date.now()})`
}

export type WorkspaceRoleName = 'admin' | 'editor' | 'viewer'

/** What the person may do in this explorer (workspace role, or the owner of personal documents). */
export interface ExplorerPermissions {
  /** Create documents and folders, import, rename and move folders. */
  canWrite: boolean
  /** Workspace admin, or the owner of personal documents. */
  isAdmin: boolean
}

export function explorerPermissions(role: WorkspaceRoleName | 'owner'): ExplorerPermissions {
  return { canWrite: role !== 'viewer', isAdmin: role === 'admin' || role === 'owner' }
}

/** Per document: edit (rename, move between folders, duplicate) and manage (delete, move workspace, share settings). */
function explorerDocPermissions(perms: ExplorerPermissions, doc: Pick<DocRow, 'isOwner'>): { canEdit: boolean, canManage: boolean } {
  return { canEdit: perms.canWrite || doc.isOwner, canManage: perms.isAdmin || doc.isOwner }
}

export type MenuAction
  = | 'open' | 'openNewTab' | 'rename' | 'moveTo' | 'duplicate' | 'copyLink' | 'share' | 'delete'
    | 'newDocument' | 'newFolder' | 'import' | 'paste' | 'cut' | 'copyLinks'

function nonEmpty(...groups: MenuAction[][]): MenuAction[][] {
  return groups.filter(g => g.length > 0)
}

function multiActions(perms: ExplorerPermissions, targets: readonly ExplorerItem[]): MenuAction[][] {
  const hasFolders = targets.some(t => t.kind === 'folder')
  const docPerms = targets.flatMap(t => (t.kind === 'doc' ? [explorerDocPermissions(perms, t.doc)] : []))
  const foldersOk = !hasFolders || perms.canWrite
  return nonEmpty(
    foldersOk && docPerms.every(p => p.canEdit) ? ['moveTo', 'cut'] : [],
    docPerms.length > 0 ? ['copyLinks'] : [],
    foldersOk && docPerms.every(p => p.canManage) ? ['delete'] : []
  )
}

function folderActions(perms: ExplorerPermissions): MenuAction[][] {
  return perms.canWrite
    ? nonEmpty(['open', 'openNewTab'], ['newDocument', 'newFolder', 'import'], ['rename', 'moveTo', 'cut', 'copyLink'], ['delete'])
    : nonEmpty(['open', 'openNewTab'], ['copyLink'])
}

function docActions(perms: ExplorerPermissions, doc: DocRow): MenuAction[][] {
  const p = explorerDocPermissions(perms, doc)
  return nonEmpty(
    ['open', 'openNewTab'],
    p.canEdit ? ['rename', 'moveTo', 'cut', 'duplicate', 'copyLink'] : ['copyLink'],
    p.canManage ? ['share'] : [],
    p.canManage ? ['delete'] : []
  )
}

/**
 * Context-menu actions, grouped in display order, for a right-click on
 * `targets` (empty = the pane's empty space). Pure so the permission matrix
 * is unit-testable.
 */
export function menuActions(perms: ExplorerPermissions, targets: readonly ExplorerItem[], opts: { canPaste: boolean }): MenuAction[][] {
  if (targets.length === 0) {
    return nonEmpty(perms.canWrite ? ['newDocument', 'newFolder', 'import'] : [], opts.canPaste && perms.canWrite ? ['paste'] : [])
  }
  if (targets.length > 1) return multiActions(perms, targets)
  const target = targets[0] as ExplorerItem
  return target.kind === 'folder' ? folderActions(perms) : docActions(perms, target.doc)
}
