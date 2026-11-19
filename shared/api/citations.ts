// Request schemas of the citation routes (server/api/citations/**).
import { z } from 'zod'

/** POST /api/citations/doi: a DOI, `doi:` form or doi.org URL. */
export const lookupDoiBody = z.object({
  doi: z.string().trim().min(1).max(300)
})
