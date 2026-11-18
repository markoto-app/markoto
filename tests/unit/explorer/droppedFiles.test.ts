import { describe, it, expect } from 'vitest'
import { collectDroppedFiles, pickedFiles } from '../../../app/utils/explorer/droppedFiles'

// What an import gets from a drop or a file picker: loose files by name,
// dropped folders with their structure kept (directory readers hand out
// their entries in batches until an empty one), unreadable files skipped.

function fileEntry(name: string, body = name, readable = true): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void, fail?: (e: unknown) => void) => (readable ? ok(new File([body], name)) : fail?.(new Error('gone')))
  } as unknown as FileSystemFileEntry
}

/** A directory whose reader returns `children` in batches of `batch`. */
function dirEntry(name: string, children: FileSystemEntry[], batch = 2, failReads = false): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let at = 0
      return {
        readEntries: (ok: (b: FileSystemEntry[]) => void, fail?: (e: unknown) => void) => {
          if (failReads) return fail?.(new Error('denied'))
          const next = children.slice(at, at + batch)
          at += batch
          ok(next)
        }
      }
    }
  } as unknown as FileSystemDirectoryEntry
}

function transfer(items: Array<{ kind: string, entry: FileSystemEntry | null } | { kind: string, noEntryApi: true }>, files: File[] = []): DataTransfer {
  return {
    items: items.map(i => ('noEntryApi' in i
      ? { kind: i.kind }
      : { kind: i.kind, webkitGetAsEntry: () => i.entry })),
    files
  } as unknown as DataTransfer
}

describe('collectDroppedFiles', () => {
  it('keeps the structure of a dropped folder, reading every batch', async () => {
    const tree = dirEntry('Notes', [
      fileEntry('a.md'),
      fileEntry('b.md'),
      dirEntry('2024', [fileEntry('c.md'), fileEntry('logo.png')]),
      fileEntry('d.md')
    ])
    const out = await collectDroppedFiles(transfer([{ kind: 'file', entry: tree }, { kind: 'file', entry: fileEntry('loose.md') }]))
    expect(out.map(f => f.path)).toEqual(['Notes/a.md', 'Notes/b.md', 'Notes/2024/c.md', 'Notes/2024/logo.png', 'Notes/d.md', 'loose.md'])
    expect(await out[0]!.file.text()).toBe('a.md')
  })

  it('skips files it cannot read and folders it cannot list', async () => {
    const out = await collectDroppedFiles(transfer([
      { kind: 'file', entry: dirEntry('Locked', [fileEntry('x.md')], 2, true) },
      { kind: 'file', entry: fileEntry('gone.md', '', false) },
      { kind: 'file', entry: fileEntry('ok.md') }
    ]))
    expect(out.map(f => f.path)).toEqual(['ok.md'])
  })

  it('ignores dropped text and falls back to the plain file list without the entry API', async () => {
    const a = new File(['x'], 'a.md')
    const b = new File(['y'], 'b.txt')
    const out = await collectDroppedFiles(transfer([{ kind: 'string', noEntryApi: true }, { kind: 'file', noEntryApi: true }], [a, b]))
    expect(out).toEqual([{ path: 'a.md', file: a }, { path: 'b.txt', file: b }])
  })
})

describe('pickedFiles', () => {
  it('keeps the picked folder in the path, else the file name', () => {
    const inFolder = Object.assign(new File(['x'], 'a.md'), { webkitRelativePath: 'Docs/sub/a.md' })
    const loose = new File(['y'], 'b.md')
    expect(pickedFiles([inFolder, loose] as unknown as FileList).map(f => f.path)).toEqual(['Docs/sub/a.md', 'b.md'])
    expect(pickedFiles(null)).toEqual([])
  })
})
