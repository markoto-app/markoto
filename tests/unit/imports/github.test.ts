import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubEnv } from '../../helpers/env'
import { safeFetch } from '../../../server/utils/platform/safeFetch'
import { downloadGithubZip, GithubImportError, parseGithubImportUrl } from '../../../server/utils/imports/github'

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

describe('downloadGithubZip: the real hosts', () => {
  beforeEach(() => {
    stubEnv({ TEST_MODE: undefined, TEST_GITHUB_IMPORT_ORIGIN: 'http://127.0.0.1:9' })
    safeFetchMock.mockReset()
  })

  it('asks api.github.com for the default branch, then codeload.github.com for the zip, through safeFetch only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    safeFetchMock.mockImplementation(async (url) => {
      if (url === 'https://api.github.com/repos/acme/handbook') return { response: ok(JSON.stringify({ default_branch: 'trunk' })), url }
      if (url === 'https://codeload.github.com/acme/handbook/zip/trunk') return { response: ok(new Uint8Array([1, 2, 3])), url }
      throw new Error(`unexpected ${url}`)
    })
    const ref = parseGithubImportUrl('https://github.com/acme/handbook')
    if (!ref) throw new Error('parse failed')
    expect([...await downloadGithubZip(ref)]).toEqual([1, 2, 3])
    expect(safeFetchMock.mock.calls.map(c => c[0])).toEqual([
      'https://api.github.com/repos/acme/handbook',
      'https://codeload.github.com/acme/handbook/zip/trunk'
    ])
    // The fake origin is ignored outside test mode.
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('skips the API when the URL names a ref (the first segment after /tree/)', async () => {
    safeFetchMock.mockImplementation(async url => ({ response: ok(new Uint8Array([9])), url }))
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/v2.0/docs')
    if (!ref) throw new Error('parse failed')
    await downloadGithubZip(ref)
    expect(safeFetchMock.mock.calls.map(c => c[0])).toEqual(['https://codeload.github.com/acme/handbook/zip/v2.0'])
  })

  it('maps 404, other failures, network errors and oversized answers to fixed reasons', async () => {
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/main')
    if (!ref) throw new Error('parse failed')
    const reason = async () => {
      try {
        await downloadGithubZip(ref)
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
    safeFetchMock.mockImplementation(async url => ({ response: ok('x', { 'content-length': String(500 * 1024 * 1024) }), url }))
    expect(await reason()).toBe('too-large')
  })

  it('refuses a default branch the API answers with that is not a plain ref', async () => {
    safeFetchMock.mockImplementation(async url => ({ response: ok(JSON.stringify({ default_branch: '../x y' })), url }))
    const ref = parseGithubImportUrl('https://github.com/acme/handbook')
    if (!ref) throw new Error('parse failed')
    await expect(downloadGithubZip(ref)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('downloadGithubZip: the test seam', () => {
  beforeEach(() => {
    stubEnv({ TEST_MODE: '1', NUXT_SITE_URL: undefined, TEST_GITHUB_IMPORT_ORIGIN: 'http://127.0.0.1:4555/' })
    safeFetchMock.mockReset()
  })

  it('calls the fake origin with plain fetch in test mode', async () => {
    const urls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      urls.push(url)
      return url.endsWith('/api/repos/acme/handbook') ? ok(JSON.stringify({ default_branch: 'main' })) : ok(new Uint8Array([7]))
    })
    const ref = parseGithubImportUrl('https://github.com/acme/handbook')
    if (!ref) throw new Error('parse failed')
    expect([...await downloadGithubZip(ref)]).toEqual([7])
    expect(urls).toEqual([
      'http://127.0.0.1:4555/api/repos/acme/handbook',
      'http://127.0.0.1:4555/codeload/acme/handbook/zip/main'
    ])
    expect(safeFetchMock).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('is not honoured when the instance looks like a real deployment', async () => {
    stubEnv({ NUXT_SITE_URL: 'https://markoto.example' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    safeFetchMock.mockImplementation(async url => ({ response: ok(new Uint8Array([1])), url }))
    const ref = parseGithubImportUrl('https://github.com/acme/handbook/tree/main')
    if (!ref) throw new Error('parse failed')
    await downloadGithubZip(ref)
    expect(safeFetchMock.mock.calls[0]?.[0]).toBe('https://codeload.github.com/acme/handbook/zip/main')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
