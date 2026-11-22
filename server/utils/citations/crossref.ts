import { normalizeCslItem, type CslItem } from '~~/shared/utils/citations/cslItem'
import { cleanCrossrefRecord } from '~~/shared/utils/citations/crossrefClean'
import { citationKeyFor, normalizeDoi } from '~~/shared/utils/citations/citationKey'
import { trimTrailingSlashes } from '~~/shared/utils/trimTrailingSlashes'
import { isTestModeEnabled } from '~~/shared/utils/security/testMode'
import { useEnv } from '~~/shared/env/load'
import { readBodyCapped, safeFetch } from '../platform/safeFetch'

/**
 * DOI → bibliography entry through Crossref's public REST API (CSL JSON
 * transform). The request carries only the DOI: no user data, no key.
 * Every hop goes through `safeFetch` (resolved once, public addresses
 * only, redirects re-checked), the body is capped, and the answer is only
 * accepted when Crossref returns the DOI that was asked for: a "verified"
 * entry, which is what the AI's `add_reference_by_doi` relies on.
 */

const CROSSREF_API = 'https://api.crossref.org'
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 10_000

export class DoiLookupError extends Error {
  constructor(public readonly reason: 'invalid' | 'not-found' | 'unavailable') {
    super(`doi lookup: ${reason}`)
    this.name = 'DoiLookupError'
  }
}

function testOrigin(): string | null {
  if (!isTestModeEnabled()) return null
  const origin = useEnv().test.crossrefOrigin
  return origin ? trimTrailingSlashes(origin) : null
}

/**
 * Look up `doiInput` (bare DOI, `doi:` or doi.org URL). The entry gets a
 * citation key from `citationKeyFor` (`taken` reports keys in use).
 */
export async function lookupDoi(doiInput: string, taken: (key: string) => boolean = () => false): Promise<CslItem> {
  const doi = normalizeDoi(doiInput)
  if (!doi) throw new DoiLookupError('invalid')
  const path = `/works/${encodeURIComponent(doi)}/transform/application/vnd.citationstyles.csl+json`
  const headers = { 'accept': 'application/vnd.citationstyles.csl+json, application/json', 'user-agent': 'markoto-citations' }
  let response: Response
  try {
    const origin = testOrigin()
    response = origin
      ? await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      : (await safeFetch(`${CROSSREF_API}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), maxRedirects: 2 })).response
  } catch {
    throw new DoiLookupError('unavailable')
  }
  if (response.status === 404) {
    await response.body?.cancel()
    throw new DoiLookupError('not-found')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new DoiLookupError('unavailable')
  }
  const body = await readBodyCapped(response, MAX_BYTES)
  if (!body) throw new DoiLookupError('unavailable')
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new DoiLookupError('unavailable')
  }
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // Verified: Crossref's record names the DOI we asked for.
  const returned = typeof record.DOI === 'string' ? record.DOI : ''
  if (returned.toLowerCase() !== doi.toLowerCase()) throw new DoiLookupError('not-found')
  const tidy = cleanCrossrefRecord(record)
  const key = citationKeyFor(normalizeCslItem({ ...tidy, id: 'tmp' }) ?? { title: '' }, taken)
  // Crossref's own `id` is not a citation key; the abstract is not kept.
  const { id: _id, abstract: _abstract, ...rest } = tidy
  const item = normalizeCslItem({ ...rest, id: key, DOI: doi })
  if (!item) throw new DoiLookupError('not-found')
  return item
}
