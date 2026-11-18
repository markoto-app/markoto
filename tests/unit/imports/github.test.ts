import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubEnv } from '../../helpers/env'
import { safeFetch } from '../../../server/utils/platform/safeFetch'
import { strFromU8, unzipSync } from 'fflate'
import { downloadGithubFiles, GithubImportError, parseGithubImportUrl } from '../../../server/utils/imports/github'

vi.mock('../../../server/utils/platform/safeFetch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/utils/platform/safeFetch')>()
  return { ...real, safeFetch: vi.fn() }
})

const safeFetchMock = vi.mocked(safeFetch)

describe('parseGithubImportUrl', () => {
  it('reads a repository URL, with or without .git and trailing slash', () => {
    for (const raw of ['https://github.com/acme/handbook', 'https://github.com/acme/handbook.git', 'https://www.github.com/acme/handbook/', '  https://github.com/acme/handbook  ']) {
      expect(parseGithubImportUrl(raw), raw).toEqual({
        owner: 'acme',
        repo: 'handbook',
        ref: null,
        path: null,
        canonicalUrl: 'https://github.com/acme/handbook'
      })
    }
  })

  it('reads a ref and a folder from a /tree/ URL', () => {
    expect(parseGithubImportUrl('https://github.com/acme/handbook/tree/v2.1/docs/guides')).toEqual({
      owner: 'acme',
      repo: 'handbook',
      ref: 'v2.1',
      path: 'docs/guides',
      canonicalUrl: 'https://github.com/acme/handbook/tree/v2.1/docs/guides'
    })
    expect(parseGithubImportUrl('https://github.com/acme/handbook/tree/main')?.path).toBeNull()
    expect(parseGithubImportUrl('https://github.com/acme/handbook/tree/main/My%20Docs')?.path).toBe('My Docs')
  })

  it('refuses other hosts, schemes, ports and credentials', () => {
    for (const raw of [
      'http://github.com/acme/handbook',
      'https://gitlab.com/acme/handbook',
      'https://github.com.evil.example/acme/handbook',
      'https://api.github.com/acme/handbook',
      'https://github.com:8443/acme/handbook',
      'https://user:pw@github.com/acme/handbook',
      'git@github.com:acme/handbook.git',
      'not a url'
    ]) {
      expect(parseGithubImportUrl(raw), raw).toBeNull()
    }
  })

  it('refuses incomplete, non-tree and traversing paths', () => {
    for (const raw of [
      'https://github.com/acme',
      'https://github.com/acme/handbook/blob/main/README.md',
      'https://github.com/acme/handbook/tree',
      'https://github.com/acme/handbook/tree/a..b',
      'https://github.com/ac me/handbook',
      'https://github.com/acme/..'
    ]) {
      expect(parseGithubImportUrl(raw), raw).toBeNull()
    }
  })
})

function ok(body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers })
}

/** A tree answer: blobs with sizes (and one directory entry, which is ignored). */
function tree(files: Record<string, number>, truncated = false): string {
  return JSON.stringify({ sha: 'x', truncated, tree: [{ path: 'dir', type: 'tree' }, ...Object.entries(files).map(([path, size]) => ({ path, type: 'blob', size }))] })
}

function zipNames(zip: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]))
}

describe('downloadGithubFiles: the real hosts', () => {
  beforeEach(() => {
    stubEnv({ TEST_MODE: undefined, TEST_GITHUB_IMPORT_ORIGIN: 'http://127.0.0.1:9' })
    safeFetchMock.mockReset()
  })

  it('lists only the folder, downloads only its importable files, through safeFetch only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    safeFetchMock.mockImplementation(async (url) => {
      if (url === 'https://api.github.com/repos/acme/handbook') return { response: ok(JSON.stringify({ default_branch: 'trunk' })), url }
      if (url === 'https://api.github.com/repos/acme/handbook/git/trees/trunk:docs/ai?recursive=1') {
        return { response: ok(tree({ 'intro.md': 7, 'deep/more.md': 6, 'tool.exe': 3, '.DS_Store': 1, 'big.png': 50 * 1024 * 1024 })), url }
      }
      if (url === 'https://raw.githubusercontent.com/acme/handbook/trunk/docs/ai/intro.md') return { response: ok('# Intro'), url }
      if (url === 'https://raw.githubusercontent.com/acme/handbook/trunk/docs/ai/deep/more.md') return { response: ok('# More'), url }
      throw new Error(`unexpected ${url}`)
    })
    const ref = { ...parseGithubImportUrl('https://github.com/acme/handbook')!, path: 'docs/ai' }
    expect(zipNames(await downloadGithubFiles(ref))).toEqual({ 'intro.md': '# Intro', 'deep/more.md': '# More' })
    expect(safeFetchMock.mock.calls.map(c => c[0]).slice(0, 2)).toEqual([
      'https://api.github.com/repos/acme/handbook',
      'https://api.github.com/repos/acme/handbook/git/trees/trunk:docs/ai?recursive=1'
    ])
    // The fake origin is ignored outside test mode.
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('skips the default-branch lookup when the URL names a ref', async () => {
    safeFetchMock.mockImplementation(async url => ({ response: ok(url.includes('/git/trees/') ? tree({}) : 'x'), url }))
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/v2.0/docs')
    if (!ref) throw new Error('parse failed')
    await downloadGithubFiles(ref)
    expect(safeFetchMock.mock.calls.map(c => c[0])).toEqual(['https://api.github.com/repos/acme/handbook/git/trees/v2.0:docs?recursive=1'])
  })

  it('refuses a selection over the archive cap, or a listing GitHub cut short, before any download', async () => {
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/main')
    if (!ref) throw new Error('parse failed')
    const many: Record<string, number> = {}
    for (let i = 0; i < 20; i++) many[`img-${i}.png`] = 9 * 1024 * 1024
    safeFetchMock.mockImplementation(async url => ({ response: ok(tree(many)), url }))
    await expect(downloadGithubFiles(ref)).rejects.toMatchObject({ reason: 'too-large' })
    safeFetchMock.mockImplementation(async url => ({ response: ok(tree({ 'a.md': 1 }, true)), url }))
    await expect(downloadGithubFiles(ref)).rejects.toMatchObject({ reason: 'too-large' })
    expect(safeFetchMock.mock.calls.every(c => String(c[0]).includes('/git/trees/'))).toBe(true)
  })

  it('maps 404, other failures, network errors, bad listings and oversized answers to fixed reasons', async () => {
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/main')
    if (!ref) throw new Error('parse failed')
    const reason = async () => {
      try {
        await downloadGithubFiles(ref)
        return null
      } catch (e) {
        return e instanceof GithubImportError ? e.reason : String(e)
      }
    }
    safeFetchMock.mockImplementation(async url => ({ response: new Response('nope', { status: 404 }), url }))
    expect(await reason()).toBe('not-found')
    safeFetchMock.mockImplementation(async url => ({ response: new Response('x', { status: 503 }), url }))
    expect(await reason()).toBe('unavailable')
    safeFetchMock.mockRejectedValue(new Error('URL refused: private address'))
    expect(await reason()).toBe('unavailable')
    safeFetchMock.mockReset()
    safeFetchMock.mockImplementation(async url => ({ response: ok('not json'), url }))
    expect(await reason()).toBe('unavailable')
    safeFetchMock.mockImplementation(async url => ({ response: ok(JSON.stringify({ tree: 'x' })), url }))
    expect(await reason()).toBe('unavailable')
    safeFetchMock.mockImplementation(async url => ({ response: ok('x', { 'content-length': String(500 * 1024 * 1024) }), url }))
    expect(await reason()).toBe('too-large')
    // A raw file larger than the listing said.
    safeFetchMock.mockImplementation(async url => ({ response: ok(url.includes('/git/trees/') ? tree({ 'a.md': 2 }) : 'x'.repeat(5000)), url }))
    expect(await reason()).toBe('too-large')
  })

  it('refuses a default branch the API answers with that is not a plain ref', async () => {
    safeFetchMock.mockImplementation(async url => ({ response: ok(JSON.stringify({ default_branch: '../x y' })), url }))
    const ref = parseGithubImportUrl('https://github.com/acme/handbook')
    if (!ref) throw new Error('parse failed')
    await expect(downloadGithubFiles(ref)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('downloadGithubFiles: the test seam', () => {
  beforeEach(() => {
    stubEnv({ TEST_MODE: '1', NUXT_SITE_URL: undefined, TEST_GITHUB_IMPORT_ORIGIN: 'http://127.0.0.1:4555/' })
    safeFetchMock.mockReset()
  })

  it('calls the fake origin with plain fetch in test mode', async () => {
    const urls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/api/repos/acme/handbook')) return ok(JSON.stringify({ default_branch: 'main' }))
      return url.includes('/git/trees/') ? ok(tree({ 'a.md': 3 })) : ok('# A')
    })
    const ref = parseGithubImportUrl('https://github.com/acme/handbook')
    if (!ref) throw new Error('parse failed')
    expect(zipNames(await downloadGithubFiles(ref))).toEqual({ 'a.md': '# A' })
    expect(urls).toEqual([
      'http://127.0.0.1:4555/api/repos/acme/handbook',
      'http://127.0.0.1:4555/api/repos/acme/handbook/git/trees/main?recursive=1',
      'http://127.0.0.1:4555/raw/acme/handbook/main/a.md'
    ])
    expect(safeFetchMock).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('is not honoured when the instance looks like a real deployment', async () => {
    stubEnv({ NUXT_SITE_URL: 'https://markoto.example' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    safeFetchMock.mockImplementation(async url => ({ response: ok(tree({})), url }))
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/main')
    if (!ref) throw new Error('parse failed')
    await downloadGithubFiles(ref)
    expect(safeFetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/acme/handbook/git/trees/main?recursive=1')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
