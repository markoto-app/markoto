import { FOLDER_MAX_DEPTH } from '../../config/imports'
import { folderNameFromSegment } from './folderName'

// Paths of imported files (an uploaded folder, a zip archive, a GitHub
// repository): normalised so they can never point outside the import, and
// split into the folders the import mirrors. Shared by the import dialog
// (preview) and the server (which re-checks everything the browser sent).

const MAX_PATH_LENGTH = 1024

/**
 * A relative path with `/` separators, no empty, `.` or `..` segments, no
 * drive letter or leading slash. Null when the path climbs out of the import
 * (`..` above its root), is absolute in a way that can't be made relative,
 * or is too long. Backslashes count as separators (Windows archives).
 */
export function normalizeImportPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) return null
  const parts: string[] = []
  const segments = raw.replace(/\\/g, '/').replace(/^[a-zA-Z]:\//, '').split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** Files the import never takes: OS metadata and hidden files or folders. */
export function isIgnoredImportPath(path: string): boolean {
  return path.split('/').some(seg => seg.startsWith('.') || seg === '__MACOSX' || seg === 'Thumbs.db' || seg === 'desktop.ini')
}

/** The folder names a file's path asks for (its directories), at most the depth limit: deeper levels fold into the last one. */
export function importFolderChain(path: string, maxDepth = FOLDER_MAX_DEPTH): string[] {
  const dirs = path.split('/').slice(0, -1).map(seg => folderNameFromSegment(seg))
  if (dirs.length <= maxDepth) return dirs
  return [...dirs.slice(0, maxDepth - 1), dirs.slice(maxDepth - 1).join(' - ')]
}

/** The file name without its extension (a document title fallback). */
export function importBaseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || name
}

/** Directory part of a normalised path ('' at the root). */
export function importDirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/**
 * Resolve a link target found in the file at `fromPath` against the import.
 * Relative targets resolve against the file's folder, a leading `/` against
 * the import's root. Query and fragment are dropped; percent-encoding is
 * decoded. Null for absolute URLs (`http:`, `data:`, `mailto:` …), anchors
 * and anything that climbs above the root.
 */
/** The path part of a link target (no `<>`, query or fragment, decoded); null for anchors and absolute URLs. */
function linkPath(target: string): string | null {
  let t = target.trim()
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1).trim()
  if (t === '' || t.startsWith('#') || /^[a-z][a-z0-9+.-]{0,30}:/i.test(t) || t.startsWith('//')) return null
  const cut = t.search(/[?#]/)
  if (cut !== -1) t = t.slice(0, cut)
  if (t === '') return null
  try {
    return decodeURIComponent(t)
  } catch {
    return t
  }
}

export function resolveImportLink(fromPath: string, target: string): string | null {
  const t = linkPath(target)
  if (t === null) return null
  const base = t.startsWith('/') ? [] : importDirName(fromPath).split('/').filter(Boolean)
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (base.length === 0) return null
      base.pop()
      continue
    }
    base.push(seg)
  }
  return base.length === 0 ? null : base.join('/')
}

/** The `#fragment` of a link target ('' when none). */
export function linkFragment(target: string): string {
  const i = target.indexOf('#')
  return i === -1 ? '' : target.slice(i)
}
