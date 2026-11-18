import { FOLDER_NAME_MAX_LENGTH } from '../../config/imports'

// Folder names: what a person may call a folder, and how a path segment from
// an import becomes one. Shared by the API schema, the explorer's inline
// rename and the import worker, so all three agree.

export type FolderNameProblem = 'empty' | 'too-long' | 'invalid'

// Control characters and the path separators (a name is never a path).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f/\\]/

/** Why `raw` (before trimming) is not a valid folder name, or null when it is. */
export function folderNameProblem(raw: string): FolderNameProblem | null {
  const name = raw.trim()
  if (name === '') return 'empty'
  if (name.length > FOLDER_NAME_MAX_LENGTH) return 'too-long'
  if (FORBIDDEN.test(name) || name === '.' || name === '..') return 'invalid'
  return null
}

/**
 * A path segment of an imported file turned into a folder name: forbidden
 * characters become spaces, whitespace collapses, the length is cut. An
 * unusable segment ('.', '..', empty) becomes `fallback`.
 */
export function folderNameFromSegment(segment: string, fallback = 'Folder'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = segment.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX_LENGTH).trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned
}
