// Request input types per route, for the typed client (app/utils/api/client.ts).
// `modules/api-contract.ts` generates `.nuxt/types/api-inputs.d.ts`, which
// augments `ApiInputs` with one entry per scanned handler. Response types come
// from Nitro's own `InternalApi`.

/** Route pattern → method → `{ params, query, body }` input types. Filled by the generated declaration. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by .nuxt/types/api-inputs.d.ts
export interface ApiInputs {}

/** What a raw `defineEventHandler` route (the dictation WebSocket) accepts: anything. */
export interface LegacyInput {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

/** The input types a handler declares through `defineApiHandler`'s phantom `~input`. */
export type ApiInputOf<H> = H extends { readonly '~input'?: infer I }
  ? unknown extends I ? LegacyInput : I
  : LegacyInput
