import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { DoiLookupError, lookupDoi } from '../../../server/utils/citations/crossref'

const safeFetchMock = vi.hoisted(() => vi.fn())
const envState = vi.hoisted(() => ({ origin: '', testMode: false }))

vi.mock('../../../server/utils/platform/safeFetch', async () => {
  const actual = await vi.importActual<typeof import('../../../server/utils/platform/safeFetch')>('../../../server/utils/platform/safeFetch')
  return { ...actual, safeFetch: (...a: unknown[]) => safeFetchMock(...a) }
})
vi.mock('~~/shared/utils/security/testMode', () => ({ isTestModeEnabled: () => envState.testMode }))
vi.mock('~~/shared/env/load', () => ({ useEnv: () => ({ test: { crossrefOrigin: envState.origin } }) }))

const RECORD = {
  DOI: '10.1000/xyz123',
  id: 'crossref-own-id',
  type: 'article-journal',
  title: 'A Study of Things',
  abstract: 'secret abstract',
  author: [{ family: 'Smith', given: 'John' }],
  issued: { 'date-parts': [[2020]] }
}

const ok = (body: unknown) => ({ response: new Response(JSON.stringify(body), { status: 200 }), url: 'x' })
const reason = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(DoiLookupError)
    return (e as DoiLookupError).reason
  }
  return null
}

describe('lookupDoi', () => {
  beforeEach(() => {
    safeFetchMock.mockReset()
    envState.origin = ''
    envState.testMode = false
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tidies an all-caps Crossref record (Turing, Mind 1950)', async () => {
    safeFetchMock.mockResolvedValue(ok({
      'DOI': '10.1093/mind/lix.236.433',
      'type': 'article-journal',
      'title': 'I.\u2014COMPUTING MACHINERY AND INTELLIGENCE',
      'author': [{ family: 'TURING', given: 'A. M.' }],
      'container-title': 'Mind',
      'publisher': 'Oxford University Press (OUP)',
      'volume': 'LIX',
      'issue': '236',
      'page': '433-460',
      'issued': { 'date-parts': [[1950]] }
    }))
    const item = await lookupDoi('10.1093/mind/LIX.236.433')
    expect(item.title).toBe('Computing Machinery and Intelligence')
    expect(item.author).toEqual([{ family: 'Turing', given: 'A. M.' }])
    expect(item['container-title']).toBe('Mind')
    expect(item.volume).toBe('LIX')
    expect(item.issue).toBe('236')
    expect(item.page).toBe('433-460')
    expect(item.id).toMatch(/^turing1950/)
  })

  it('rejects input that is not a DOI without any request', async () => {
    expect(await reason(lookupDoi('not a doi'))).toBe('invalid')
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('returns a verified entry with a generated key and no abstract', async () => {
    safeFetchMock.mockResolvedValue(ok(RECORD))
    const item = await lookupDoi('https://doi.org/10.1000/xyz123')
    expect(item.DOI).toBe('10.1000/xyz123')
    expect(item.id).toBe('smith2020study')
    expect(item.title).toBe('A Study of Things')
    expect(JSON.stringify(item)).not.toContain('secret abstract')
    const [url, init] = safeFetchMock.mock.calls[0]!
    expect(url).toBe('https://api.crossref.org/works/10.1000%2Fxyz123/transform/application/vnd.citationstyles.csl+json')
    expect(init.maxRedirects).toBe(2)
  })

  it('avoids keys that are taken', async () => {
    safeFetchMock.mockResolvedValue(ok(RECORD))
    const item = await lookupDoi('10.1000/xyz123', k => k === 'smith2020study')
    expect(item.id).toBe('smith2020studya')
  })

  it('maps 404 to not-found and other statuses to unavailable', async () => {
    safeFetchMock.mockResolvedValueOnce({ response: new Response('', { status: 404 }), url: 'x' })
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('not-found')
    safeFetchMock.mockResolvedValueOnce({ response: new Response('', { status: 503 }), url: 'x' })
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('unavailable')
  })

  it('maps network errors and timeouts to unavailable', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('timeout'))
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('unavailable')
  })

  it('maps an unparsable body to unavailable', async () => {
    safeFetchMock.mockResolvedValue({ response: new Response('<html>', { status: 200 }), url: 'x' })
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('unavailable')
  })

  it('maps an empty body to unavailable', async () => {
    safeFetchMock.mockResolvedValue({ response: new Response('', { status: 200 }), url: 'x' })
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('unavailable')
  })

  it('refuses a record that names a different DOI', async () => {
    safeFetchMock.mockResolvedValue(ok({ ...RECORD, DOI: '10.9999/other' }))
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('not-found')
  })

  it('refuses a JSON body that is not an object', async () => {
    safeFetchMock.mockResolvedValue(ok([1, 2]))
    expect(await reason(lookupDoi('10.1000/xyz123'))).toBe('not-found')
  })

  it('uses the fake Crossref origin in test mode, without safeFetch', async () => {
    envState.testMode = true
    envState.origin = 'http://127.0.0.1:9999/'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(RECORD), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const item = await lookupDoi('10.1000/xyz123')
    expect(item.DOI).toBe('10.1000/xyz123')
    expect(fetchMock.mock.calls[0]![0]).toMatch(/^http:\/\/127\.0\.0\.1:9999\/works\//)
    expect(safeFetchMock).not.toHaveBeenCalled()
  })

  it('ignores the fake origin outside test mode', async () => {
    envState.origin = 'http://127.0.0.1:9999'
    safeFetchMock.mockResolvedValue(ok(RECORD))
    await lookupDoi('10.1000/xyz123')
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
  })
})
