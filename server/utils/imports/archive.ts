import { unzipSync } from 'fflate'
import { IMPORT_ARCHIVE_MAX_ENTRIES, IMPORT_ARCHIVE_MAX_RATIO } from '~~/shared/config/imports'
import { isIgnoredImportPath, normalizeImportPath } from '~~/shared/utils/documents/importPaths'

// Zip archives in an import (an uploaded .zip, a GitHub repository download).
// The directory is read first, without inflating anything, and refused as a
// whole when it lists too many entries, expands past the job's byte budget,
// or an entry expands more than the allowed ratio (zip bomb). Entry names
// are normalised like uploaded paths: one that climbs out of the archive is
// skipped. Entries are inflated later, a few at a time, into buffers of the
// declared size: an entry that lies about its size fails to inflate.

export class ArchiveRejectedError extends Error {
  constructor(public readonly reason: 'too-many-entries' | 'too-large' | 'ratio' | 'unreadable') {
    super(`archive rejected: ${reason}`)
    this.name = 'ArchiveRejectedError'
  }
}

export interface ArchiveEntry {
  /** Normalised path inside the archive (after `stripPrefix`). */
  path: string
  /** The entry's name as stored (to inflate it). */
  rawName: string
  /** Expanded size as declared by the archive. */
  size: number
}

export interface ArchiveListing {
  entries: ArchiveEntry[]
  /** Entries skipped: directories excluded, unsafe paths, hidden / system files. */
  skipped: number
  expandedBytes: number
}

/**
 * The archive's file entries. `stripPrefix` removes a leading folder from
 * every name (a GitHub download wraps everything in `<repo>-<ref>/`) and,
 * with `under`, keeps only entries below that folder.
 */
export function listArchive(data: Uint8Array, opts: { maxExpandedBytes: number, stripPrefix?: boolean, under?: string }): ArchiveListing {
  const entries: ArchiveEntry[] = []
  let skipped = 0
  let count = 0
  let expanded = 0
  let failure: ArchiveRejectedError | null = null
  try {
    unzipSync(data, {
      // Reads the directory only: every entry is recorded and none inflated.
      // eslint-disable-next-line sonarjs/no-invariant-returns -- the filter's answer is always "don't inflate" by design
      filter: (file) => {
        if (failure) return false
        count++
        if (count > IMPORT_ARCHIVE_MAX_ENTRIES) {
          failure = new ArchiveRejectedError('too-many-entries')
          return false
        }
        if (file.name.endsWith('/')) return false
        const compressed = Math.max(file.size, 1)
        if (file.originalSize / compressed > IMPORT_ARCHIVE_MAX_RATIO && file.originalSize > 1024 * 1024) {
          failure = new ArchiveRejectedError('ratio')
          return false
        }
        let name = file.name
        if (opts.stripPrefix) {
          const slash = name.indexOf('/')
          name = slash === -1 ? '' : name.slice(slash + 1)
        }
        let path = normalizeImportPath(name)
        if (path && opts.under) {
          path = path === opts.under || !path.startsWith(`${opts.under}/`) ? null : path.slice(opts.under.length + 1)
        }
        if (!path || isIgnoredImportPath(path)) {
          skipped++
          return false
        }
        expanded += file.originalSize
        if (expanded > opts.maxExpandedBytes) {
          failure = new ArchiveRejectedError('too-large')
          return false
        }
        entries.push({ path, rawName: file.name, size: file.originalSize })
        return false
      }
    })
  } catch {
    throw new ArchiveRejectedError('unreadable')
  }
  if (failure) throw failure
  return { entries, skipped, expandedBytes: expanded }
}

/** Inflate the named entries (raw names). Missing or unreadable entries are absent from the result. */
export function extractArchiveEntries(data: Uint8Array, rawNames: ReadonlySet<string>): Map<string, Uint8Array> {
  if (rawNames.size === 0) return new Map()
  try {
    const out = unzipSync(data, { filter: file => rawNames.has(file.name) })
    return new Map(Object.entries(out))
  } catch {
    // One broken entry fails the whole call: retry one by one.
    const out = new Map<string, Uint8Array>()
    for (const name of rawNames) {
      try {
        const one = unzipSync(data, { filter: file => file.name === name })[name]
        if (one) out.set(name, one)
      } catch { /* unreadable entry: left out */ }
    }
    return out
  }
}
