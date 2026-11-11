import { publishedFileUrl } from '~~/shared/config/publish'
import { ID_PATTERN } from '~~/shared/config/identifiers'

// The files a web snapshot refers to. The print page writes this
// document's uploads as `/api/files/<docId>/<fileId>` and its workspace's
// brand-kit files as `/api/docs/<docId>/brand/<file>` (tokens already
// stripped). Publishing copies exactly those files to the page's own S3
// prefix and rewrites the URLs to `/api/published/<pageId>/...`, so the
// page keeps working when the document changes, loses an image to the GC,
// turns private or is deleted while the page is up. Anything else (other
// documents' files, external URLs) is left as is.

const ID = ID_PATTERN
const FILE = String.raw`${ID}\.(?:png|jpe?g|gif|webp)`
const BRAND_FILE = String.raw`[A-Za-z0-9_-]{16}\.(?:woff2|woff|ttf|png|jpg|webp)`

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patterns(docId: string): { files: RegExp, brand: RegExp } {
  const id = escapeRe(docId)
  return {
    // Not preceded by a word / path character: `/api/files/…` as a whole
    // URL path, also inside url('…') and src="…".
    files: new RegExp(String.raw`(?<![\w./-])/api/files/${id}/(${FILE})(?![\w.-])`, 'g'),
    brand: new RegExp(String.raw`(?<![\w./-])/api/docs/${id}/brand/(${BRAND_FILE})(?![\w.-])`, 'g')
  }
}

export interface SnapshotAssetRefs {
  files: Set<string>
  brand: Set<string>
}

export function collectSnapshotAssets(texts: readonly string[], docId: string): SnapshotAssetRefs {
  const out: SnapshotAssetRefs = { files: new Set(), brand: new Set() }
  const re = patterns(docId)
  for (const text of texts) {
    for (const m of text.matchAll(re.files)) out.files.add(m[1]!)
    for (const m of text.matchAll(re.brand)) out.brand.add(m[1]!)
  }
  return out
}

/** Rewrite the references that were copied; unknown files stay as they are. */
export function rewriteSnapshotAssets(text: string, docId: string, pageId: string, copied: SnapshotAssetRefs): string {
  const re = patterns(docId)
  return text
    .replace(re.files, (whole, file: string) => copied.files.has(file) ? publishedFileUrl(pageId, 'files', file) : whole)
    .replace(re.brand, (whole, file: string) => copied.brand.has(file) ? publishedFileUrl(pageId, 'brand', file) : whole)
}

/** S3 key of a published page's copied file. */
export function publishedObjectKey(pageId: string, kind: 'files' | 'brand', file: string): string {
  return `published/${pageId}/${kind}/${file}`
}

export function publishedPrefix(pageId: string): string {
  return `published/${pageId}/`
}
