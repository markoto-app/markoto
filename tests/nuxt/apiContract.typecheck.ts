// Compile-time tests of the API contract, checked by `bun run typecheck`
// (tests/nuxt/** is part of the app tsconfig). Nothing here runs: a broken
// expectation is a type error, an `@ts-expect-error` that no longer errors is
// one too.
import { z } from 'zod'
import { apiFetch, type ApiRequest, type ApiResponse, type PathKeys } from '~/utils/api/client'
import { defineApiHandler, type HasSecretKey } from '~~/server/utils/api/defineApiHandler'
import { allow } from '~~/server/utils/api/policy'
import { apiError } from '~~/server/utils/api/apiError'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_value?: T): void {}

export function responseTypes(): void {
  // A converted route: the response is inferred from the handler's return.
  type Tokens = ApiResponse<'/api/mcp/tokens', 'get'>
  expectType<Equal<Tokens[number]['lastUsedAt'], string | null>>()
  expectType<Equal<ApiResponse<'/api/docs/:docId/share-settings', 'put'>, { expiresAt: string | null, noDownload: boolean }>>()
  void (async () => {
    const _tokens = await apiFetch('/api/mcp/tokens')
    expectType<Equal<typeof _tokens, Tokens>>()
  })
}

export function requestTypes(): void {
  expectType<Equal<PathKeys<'/api/files/:docId/:fileId'>, 'docId' | 'fileId'>>()
  type Body = ApiRequest<'/api/docs/:docId/share-settings', 'put'>['body']
  expectType<Equal<NonNullable<Body>, { expiresAt?: string | null, noDownload?: boolean }>>()

  void apiFetch('/api/docs/:docId/share-settings', { method: 'put', path: { docId: 'd' }, body: { noDownload: true } })
  // @ts-expect-error a field the body schema does not have
  void apiFetch('/api/docs/:docId/share-settings', { method: 'put', path: { docId: 'd' }, body: { noDownlaod: true } })
  // @ts-expect-error a wrongly typed field
  void apiFetch('/api/docs/:docId/share-settings', { method: 'put', path: { docId: 'd' }, body: { noDownload: 'yes' } })
  // @ts-expect-error the path parameter is required
  void apiFetch('/api/docs/:docId/share-settings', { method: 'put', body: {} })
  // @ts-expect-error no options at all on a route with a path parameter
  void apiFetch('/api/docs/:docId/share-settings')
  // A SCIM body is any JSON object (the IdP sends its vendor's attributes).
  void apiFetch('/scim/v2/Users', { method: 'post', body: { anything: 1 } })
}

export function secretKeyGuard(): void {
  expectType<Equal<HasSecretKey<{ a: { b: Array<{ passwordHash: string }> } }>, true>>()
  expectType<Equal<HasSecretKey<{ a: string, at: Date }>, false>>()

  defineApiHandler({ access: allow.user(), handler: () => ({ ok: true }) })
  // @ts-expect-error a response carrying a secret column does not compile
  defineApiHandler({ access: allow.user(), handler: () => ({ user: { id: 1, passwordHash: 'x' } }) })
  // @ts-expect-error nested in a list too
  defineApiHandler({ access: allow.doc('lookup', { reason: 'test' }), handler: ({ doc }) => [doc] })
}

export function handlerContext(): void {
  defineApiHandler({
    access: allow.doc('manage'),
    params: z.object({ docId: z.string() }),
    body: z.object({ n: z.number() }),
    handler: (ctx) => {
      expectType<Equal<typeof ctx.user.id, number>>()
      expectType<Equal<typeof ctx.docId, string>>()
      expectType<Equal<typeof ctx.params.docId, string>>()
      expectType<Equal<typeof ctx.body.n, number>>()
      return { title: ctx.doc.title }
    }
  })
  defineApiHandler({
    access: allow.doc('file', { anonymous: true }),
    handler: (_ctx) => {
      expectType<Equal<typeof _ctx.user, { id: number, name: string } | null>>()
      return null
    }
  })
}

export function errorParams(): void {
  apiError('share/not-allowed')
  apiError('share/expiry-too-far', { maxDays: 3 })
  // @ts-expect-error a required param is missing
  apiError('share/expiry-too-far', { field: 'expiresAt' })
  // @ts-expect-error not a registered code
  apiError('share/not-a-code')
  // @ts-expect-error a status the code is not registered with
  apiError('share/not-allowed', undefined, { status: 404 })
}

export function multipartBodies(): void {
  // `body: 'multipart'`: the client sends a FormData, nothing else.
  expectType<Equal<ApiRequest<'/api/import', 'post'>['body'], FormData>>()
  void apiFetch('/api/import', { method: 'post', body: new FormData() })
  // @ts-expect-error a JSON body is not a form upload
  void apiFetch('/api/import', { method: 'post', body: { file: 'x' } })
  defineApiHandler({
    access: allow.user(),
    body: 'multipart',
    handler: (ctx) => {
      // The handler reads the form itself (size-limited reader).
      expectType<Equal<typeof ctx.body, undefined>>()
      void ctx
      return null
    }
  })
}

export function preciseResponses(): void {
  // Discriminated answers the client can narrow without runtime guards.
  type Password = ApiResponse<'/api/docs/:docId/password', 'post'>
  expectType<Equal<Extract<Password, { action: 'verify' }>['token'], string>>()
  type Meta = ApiResponse<'/api/docs/:docId/meta', 'get'>
  expectType<Equal<Extract<Meta, { granted: true }>['title'], string>>()
  type Brand = ApiResponse<'/api/workspaces/:wsId/brand', 'get'>
  expectType<Equal<Brand['fonts'][number]['format'], 'woff2' | 'woff' | 'ttf'>>()
}
