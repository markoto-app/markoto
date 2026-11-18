// Bulk import (files, folders, zip archives, public GitHub repositories):
// the platform ceilings and the vocabulary shared by the server, the worker
// and the import dialog. Per-plan caps (files and bytes per job) live in
// `tiers.ts` (`importFilesPerJob`, `importBytesPerJob`).
import { MIB } from './units'
import { IMAGE_UPLOAD_MAX_BYTES, IMPORT_MARKDOWN_MAX_BYTES, IMPORT_MAX_BYTES } from './uploads'

export const IMPORT_JOB_SOURCES = ['upload', 'github'] as const
export type ImportJobSource = typeof IMPORT_JOB_SOURCES[number]

/**
 * `uploading`: created, the browser is still putting files into storage.
 * `queued` → `running` (claimed by a worker) → `done` / `failed` /
 * `cancelled`. A job's documents stay when it is cancelled or fails halfway.
 */
export const IMPORT_JOB_STATUSES = ['uploading', 'queued', 'running', 'done', 'failed', 'cancelled'] as const
export type ImportJobStatus = typeof IMPORT_JOB_STATUSES[number]
export const ACTIVE_IMPORT_JOB_STATUSES: readonly ImportJobStatus[] = ['uploading', 'queued', 'running']

/** `doc`: becomes a document; `image`: referenced by a Markdown file; `archive`: a zip expanded by the worker. */
export const IMPORT_ITEM_KINDS = ['doc', 'image', 'archive'] as const
export type ImportItemKind = typeof IMPORT_ITEM_KINDS[number]

export const IMPORT_ITEM_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const
export type ImportItemStatus = typeof IMPORT_ITEM_STATUSES[number]

/**
 * Why one file did not become a document (shown per file in the result;
 * texts `imports.reason.<code>`). Fixed codes, never converter output.
 */
export const IMPORT_ITEM_REASONS = [
  'not-uploaded',
  'too-large',
  'unsupported',
  'not-utf8',
  'too-long',
  'conversion-failed',
  'cancelled',
  'unreadable'
] as const
export type ImportItemReason = typeof IMPORT_ITEM_REASONS[number]

/** Files that become documents as they are. */
export const IMPORT_MARKDOWN_EXTENSIONS = ['md', 'markdown'] as const
/** Files converted to Markdown by markitdown (same set as the editor's single-file import). */
export const IMPORT_CONVERTED_EXTENSIONS = ['docx', 'pdf', 'pptx', 'xlsx', 'xls', 'html', 'htm', 'epub'] as const
/** Images taken along when a Markdown file of the same import links to them (relative path). */
export const IMPORT_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export const IMPORT_ARCHIVE_EXTENSIONS = ['zip'] as const

export type ImportFileClass = 'markdown' | 'converted' | 'image' | 'archive' | 'other'

/** File extension, lower case, without the dot ('' when there is none). */
export function importExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function classifyImportFile(path: string): ImportFileClass {
  const ext = importExtension(path)
  if ((IMPORT_MARKDOWN_EXTENSIONS as readonly string[]).includes(ext)) return 'markdown'
  if ((IMPORT_CONVERTED_EXTENSIONS as readonly string[]).includes(ext)) return 'converted'
  if ((IMPORT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image'
  if ((IMPORT_ARCHIVE_EXTENSIONS as readonly string[]).includes(ext)) return 'archive'
  return 'other'
}

/** Largest single file of each class (platform ceilings; the plan's `importMaxBytes` can only lower the converted one). */
export const IMPORT_FILE_MAX_BYTES: Record<Exclude<ImportFileClass, 'other'>, number> = {
  markdown: IMPORT_MARKDOWN_MAX_BYTES,
  converted: IMPORT_MAX_BYTES,
  image: IMAGE_UPLOAD_MAX_BYTES,
  archive: 100 * MIB
}

/**
 * A zip archive (uploaded, or a GitHub repository's download) is held in the
 * worker's memory while it is expanded, so its compressed size is capped
 * independently of the plan. Expanded, it counts against the plan's bytes
 * per job like loose files.
 */
export const IMPORT_ARCHIVE_MAX_BYTES = IMPORT_FILE_MAX_BYTES.archive
/** Entries an archive may list (also bounds the work of reading its directory). */
export const IMPORT_ARCHIVE_MAX_ENTRIES = 20_000
/** An entry that inflates more than this ratio is refused (zip bomb). */
export const IMPORT_ARCHIVE_MAX_RATIO = 100

/** Longest Markdown body one imported document may have (UTF-16 code units). */
export const IMPORT_DOC_MAX_CHARS = 2_000_000

/** Deepest folder nesting kept from an import (deeper paths are flattened into the last level). */
export const FOLDER_MAX_DEPTH = 8
/** Longest folder name. */
export const FOLDER_NAME_MAX_LENGTH = 120

/** Jobs a user may start per day, and how long finished job records are kept. */
export const IMPORT_JOBS_PER_DAY = 20
export const IMPORT_JOB_RETENTION_DAYS = 30
