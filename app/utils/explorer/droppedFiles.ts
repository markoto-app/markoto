// Files a person drops or picks for an import, with their path inside what
// was dropped (a dropped folder keeps its structure). Browsers expose folder
// contents only through `webkitGetAsEntry` (drop) or `webkitRelativePath`
// (an `<input webkitdirectory>`).

export interface PickedFile {
  /** Relative path with `/` separators ("Notes/2024/a.md"; just the name for a loose file). */
  path: string
  file: File
}

/** Entries a directory reader may return per call; it has to be called until it returns none. */
function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const out: FileSystemEntry[] = []
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(out)
      else {
        out.push(...batch)
        next()
      }
    }, () => resolve(out))
    next()
  })
}

function fileOf(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise(resolve => entry.file(f => resolve(f), () => resolve(null)))
}

const MAX_FILES = 20_000

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry)
    if (file) out.push({ path: `${prefix}${entry.name}`, file })
    return
  }
  if (entry.isDirectory) {
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader())
    for (const child of children) await walk(child, `${prefix}${entry.name}/`, out)
  }
}

/** Everything dropped: files and the contents of dropped folders. */
export async function collectDroppedFiles(transfer: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = []
  const entries = [...transfer.items]
    .filter(i => i.kind === 'file')
    .map(i => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null))
  if (entries.some(e => e !== null)) {
    for (const entry of entries) if (entry) await walk(entry, '', out)
    return out
  }
  return [...transfer.files].map(file => ({ path: file.name, file }))
}

/** Files from an `<input type="file">` (with `webkitdirectory`, paths keep the picked folder). */
export function pickedFiles(list: FileList | null): PickedFile[] {
  return [...(list ?? [])].map(file => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }))
}
