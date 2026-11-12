// Parsers for the LiteLLM proxy's admin API answers. The proxy is our own
// container, but its JSON shape changes between LiteLLM versions; every
// field is read through these schemas so a skew shows up as a missing value
// (handled by the caller) instead of a crash on a wrong type. Unknown or
// mistyped fields fall back rather than fail the whole answer.
import { z } from 'zod'

const optionalNumber = z.number().nullish().catch(null)
const optionalString = z.string().nullish().catch(null)

/** `team_info` of GET /team/info. */
export const litellmTeamInfo = z.object({
  max_budget: optionalNumber,
  spend: optionalNumber,
  budget_duration: optionalString,
  budget_reset_at: optionalString
})
export type LitellmTeamInfo = z.infer<typeof litellmTeamInfo>

/** GET /team/info. */
export const litellmTeamInfoResponse = z.object({ team_info: litellmTeamInfo.nullish().catch(null) })

/**
 * POST /key/generate. `key` is the `sk-…` bearer token; the bookkeeping
 * handle comes as `token_id` (newer versions) or `token`.
 */
export const litellmKeyGenerateResponse = z.object({
  key: optionalString,
  token_id: optionalString,
  token: optionalString
})

/** GET /key/info: the key's spend and budget. */
export const litellmKeyInfoResponse = z.object({
  info: z.object({ spend: optionalNumber, max_budget: optionalNumber }).nullish().catch(null)
})

/** One entry of GET /key/list?return_full_object=true. */
const litellmListedKey = z.object({
  token: z.string(),
  team_id: optionalString,
  max_budget: optionalNumber,
  budget_duration: optionalString
})
export type LitellmListedKey = z.infer<typeof litellmListedKey>

/** GET /key/list: entries that aren't a key object with a token are skipped. */
export const litellmKeyListResponse = z.object({
  keys: z.array(z.unknown()).catch([]).transform(keys => keys.flatMap((k) => {
    const parsed = litellmListedKey.safeParse(k)
    return parsed.success ? [parsed.data] : []
  })),
  total_pages: optionalNumber
})
