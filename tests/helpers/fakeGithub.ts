import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A fake GitHub for import tests (TEST_GITHUB_IMPORT_ORIGIN points here):
// the repository endpoint (default branch), the git tree of a tree-ish
// (`<ref>` or `<ref>:<folder>`, recursive) and raw files, for repositories
// whose files are given as path -> bytes. Every request path is recorded.

export interface FakeGithubRepo {
  owner: string
  repo: string
  defaultBranch: string
  files: Record<string, Uint8Array>
  /** Answer the tree listing as cut short by GitHub. */
  truncated?: boolean
}

export interface FakeGithub {
  origin: string
  requests: string[]
  close: () => Promise<void>
}

function treeFor(repo: FakeGithubRepo, folder: string | null) {
  const prefix = folder ? `${folder}/` : ''
  const dirs = new Set<string>()
  const tree: Array<{ path: string, type: string, size?: number }> = []
  for (const [path, bytes] of Object.entries(repo.files)) {
    if (!path.startsWith(prefix)) continue
    const rel = path.slice(prefix.length)
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    tree.push({ path: rel, type: 'blob', size: bytes.byteLength })
  }
  for (const d of dirs) tree.push({ path: d, type: 'tree' })
  return tree
}

function answer(repo: FakeGithubRepo, path: string): { status: number, body: string | Uint8Array, type?: string } | null {
  const base = `/${repo.owner}/${repo.repo}`
  if (path === `/api/repos${base}`) return { status: 200, body: JSON.stringify({ default_branch: repo.defaultBranch }) }
  const treePrefix = `/api/repos${base}/git/trees/`
  if (path.startsWith(treePrefix)) {
    const treeish = path.slice(treePrefix.length)
    const colon = treeish.indexOf(':')
    const ref = colon === -1 ? treeish : treeish.slice(0, colon)
    const folder = colon === -1 ? null : treeish.slice(colon + 1)
    if (ref !== repo.defaultBranch) return { status: 404, body: '{}' }
    if (folder && !Object.keys(repo.files).some(p => p.startsWith(`${folder}/`))) return { status: 404, body: '{}' }
    return { status: 200, body: JSON.stringify({ sha: 'x', tree: treeFor(repo, folder), truncated: repo.truncated ?? false }) }
  }
  const rawPrefix = `/raw${base}/${repo.defaultBranch}/`
  if (path.startsWith(rawPrefix)) {
    const file = repo.files[path.slice(rawPrefix.length)]
    return file ? { status: 200, body: file, type: 'application/octet-stream' } : { status: 404, body: 'not found', type: 'text/plain' }
  }
  return null
}

export async function startFakeGithub(repos: FakeGithubRepo[], port = 0): Promise<FakeGithub> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://fake').pathname)
    requests.push(path)
    const found = repos.map(r => answer(r, path)).find(a => a !== null) ?? { status: 404, body: '{}' }
    res.writeHead(found.status, { 'content-type': found.type ?? 'application/json' })
    res.end(typeof found.body === 'string' ? found.body : Buffer.from(found.body))
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}
