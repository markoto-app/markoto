import { safeFetch, readBodyCapped } from '../platform/safeFetch'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { useEnv } from '~~/shared/env/load'
import { zipSync } from 'fflate'
import { classifyImportFile, IMPORT_ARCHIVE_MAX_BYTES, IMPORT_ARCHIVE_MAX_ENTRIES, IMPORT_FILE_MAX_BYTES } from '~~/shared/config/imports'
import { isIgnoredImportPath, normalizeImportPath } from '~~/shared/utils/documents/importPaths'

// Importing from a public GitHub repository (or a folder of one). Only two
// hosts are ever contacted, both through `safeFetch` (resolved once, public
// addresses only, every redirect re-checked, byte cap): api.github.com for
// the default branch and the file listing of the requested folder,
// raw.githubusercontent.com for each importable file in it. A folder of a
// large repository costs only that folder, never the whole archive. No token
// is sent: private repositories are out of reach by design (the user
// downloads the zip and imports that instead). What is sent to GitHub: the
// repository path the user typed, from the server's address.

export interface GithubImportRef {
  owner: string
  repo: string
  /** Branch, tag or commit from a `/tree/<ref>/…` URL; null = the default branch. */
  ref: string | null
  /** Folder inside the repository to import; null = everything. */
  path: string | null
  canonicalUrl: string
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const REF = /^[A-Za-z0-9_.\-/]{1,200}$/

function githubPathParts(raw: string): string[] | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') || url.port || url.username || url.password) return null
  return url.pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
}

/** `https://github.com/<owner>/<repo>[.git][/tree/<ref>[/<path>]]`, or null. */
export function parseGithubImportUrl(raw: string): GithubImportRef | null {
  const parts = githubPathParts(raw)
  if (!parts || parts.length < 2) return null
  const owner = parts[0] as string
  const repo = (parts[1] as string).replace(/\.git$/, '')
  if (!NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') return null
  let ref: string | null = null
  let path: string | null = null
  if (parts.length > 2) {
    if (parts[2] !== 'tree' || parts.length < 4) return null
    ref = parts[3] as string
    if (!REF.test(ref) || ref.includes('..')) return null
    const rest = parts.slice(4)
    if (rest.some(p => p === '..' || p === '.')) return null
    path = rest.length > 0 ? rest.join('/') : null
  }
  const canonicalUrl = `https://github.com/${owner}/${repo}${ref ? `/tree/${ref}${path ? `/${path}` : ''}` : ''}`
  return { owner, repo, ref, path, canonicalUrl }
}

export class GithubImportError extends Error {
  constructor(public readonly reason: 'not-found' | 'unavailable' | 'too-large') {
    super(`github import: ${reason}`)
    this.name = 'GithubImportError'
  }
}

/** Test seam: a fake GitHub origin (test mode only). */
function testOrigin(): string | null {
  if (!isTestModeEnabled()) return null
  const origin = useEnv().test.githubImportOrigin
  return origin ? trimTrailingSlashes(origin) : null
}

async function get(url: string, testUrl: string | null, maxBytes: number, accept: string): Promise<Uint8Array> {
  let response: Response
  try {
    if (testUrl) {
      response = await fetch(testUrl, { headers: { accept }, signal: AbortSignal.timeout(60_000) })
    } else {
      response = (await safeFetch(url, {
        headers: { 'accept': accept, 'user-agent': 'markoto-import' },
        signal: AbortSignal.timeout(120_000),
        maxRedirects: 3
      })).response
    }
  } catch {
    throw new GithubImportError('unavailable')
  }
  if (response.status === 404) throw new GithubImportError('not-found')
  if (!response.ok) throw new GithubImportError('unavailable')
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) {
    await response.body?.cancel()
    throw new GithubImportError('too-large')
  }
  const body = await readBodyCapped(response, maxBytes)
  if (!body) throw new GithubImportError('too-large')
  return body
}

/** The ref to download: the one in the URL, else the repository's default branch. */
async function resolveRef(ref: GithubImportRef): Promise<string> {
  if (ref.ref) return ref.ref
  const origin = testOrigin()
  const api = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
  const body = await get(api, origin ? `${origin}/api/repos/${ref.owner}/${ref.repo}` : null, 1024 * 1024, 'application/vnd.github+json')
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { default_branch?: unknown, private?: unknown }
    if (typeof parsed.default_branch !== 'string' || !REF.test(parsed.default_branch)) throw new GithubImportError('unavailable')
    return parsed.default_branch
  } catch (e) {
    if (e instanceof GithubImportError) throw e
    throw new GithubImportError('unavailable')
  }
}

const TREE_MAX_BYTES = 8 * 1024 * 1024
/** Files fetched from raw.githubusercontent.com at the same time. */
const RAW_CONCURRENCY = 6

interface TreeEntry { path: string, type: string, size?: number }

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * The importable files of the repository (or of its folder): the git tree
 * of exactly that folder, from the API, so a large repository costs only the
 * listing of the part that was asked for. Files that can't be imported, and
 * files over their kind's size limit, are left out before anything is
 * downloaded; the whole selection is refused above the archive cap.
 */
async function listGithubFiles(ref: GithubImportRef, branch: string): Promise<TreeEntry[]> {
  const origin = testOrigin()
  const treeish = ref.path ? `${encodePath(branch)}:${encodePath(ref.path)}` : encodePath(branch)
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/git/trees/${treeish}?recursive=1`
  const body = await get(`https://api.github.com${base}`, origin ? `${origin}/api${base}` : null, TREE_MAX_BYTES, 'application/vnd.github+json')
  let tree: { tree?: unknown, truncated?: unknown }
  try {
    tree = JSON.parse(new TextDecoder().decode(body)) as typeof tree
  } catch {
    throw new GithubImportError('unavailable')
  }
  if (!Array.isArray(tree.tree)) throw new GithubImportError('unavailable')
  // A listing GitHub cut short would import part of the folder silently.
  if (tree.truncated === true) throw new GithubImportError('too-large')
  const files: TreeEntry[] = []
  let bytes = 0
  for (const raw of tree.tree as TreeEntry[]) {
    if (raw?.type !== 'blob' || typeof raw.path !== 'string' || typeof raw.size !== 'number') continue
    const path = normalizeImportPath(raw.path)
    if (!path || isIgnoredImportPath(path)) continue
    const cls = classifyImportFile(path)
    if (cls === 'other' || cls === 'archive' || raw.size > IMPORT_FILE_MAX_BYTES[cls]) continue
    bytes += raw.size
    if (files.length >= IMPORT_ARCHIVE_MAX_ENTRIES || bytes > IMPORT_ARCHIVE_MAX_BYTES) throw new GithubImportError('too-large')
    files.push({ path: raw.path, type: 'blob', size: raw.size })
  }
  return files
}

/**
 * Download the importable files of the repository, or of the folder in the
 * URL, and hand them over as one zip (stored, not compressed) whose paths are
 * relative to that folder, so they go through the same checks as an
 * uploaded archive.
 */
export async function downloadGithubFiles(ref: GithubImportRef): Promise<Uint8Array> {
  const branch = await resolveRef(ref)
  const files = await listGithubFiles(ref, branch)
  const origin = testOrigin()
  const prefix = ref.path ? `${ref.path}/` : ''
  const out: Record<string, Uint8Array> = {}
  let next = 0
  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next++] as TreeEntry
      const rawPath = `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${encodePath(branch)}/${encodePath(prefix + file.path)}`
      out[file.path] = await get(`https://raw.githubusercontent.com${rawPath}`, origin ? `${origin}/raw${rawPath}` : null, (file.size ?? 0) + 1024, 'application/octet-stream')
    }
  }
  await Promise.all(Array.from({ length: Math.min(RAW_CONCURRENCY, files.length) }, () => worker()))
  return zipSync(out, { level: 0 })
}
