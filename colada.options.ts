// Options for the PiniaColada plugin, read by @pinia/colada-nuxt from the
// project root. The values live in app/queries/defaults.ts next to the
// queries that rely on them.
import type { PiniaColadaOptions } from '@pinia/colada'
import { QUERY_DEFAULTS } from './app/queries/defaults'

export default {
  queryOptions: QUERY_DEFAULTS
} satisfies PiniaColadaOptions
