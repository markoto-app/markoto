# API handlers: the handler contract and how to convert a route

Every route in `server/api/` and `server/routes/` declares, in one object, who may call it, what it accepts and which gates it passes. The wrapper (`server/utils/api/defineApiHandler.ts`) runs those declarations in a fixed order and hands the handler a typed context. The only handler outside it is the dictation WebSocket (`tests/unit/platform/apiRoutes.exceptions.ts`); this page is the recipe for writing or changing a route.

```ts
// server/api/docs/[docId]/share-settings/index.put.ts
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/not-allowed' }),
  body: updateShareSettingsBody,                 // shared/api/docs.ts
  invalidCode: 'share/invalid',                  // keeps the route's existing 400 code
  rateLimit: { namespace: 'share-settings', max: 30, windowMs: 10 * MINUTE_MS, key: 'user', error: 'share/rate-limited' },
  handler: async ({ event, user, docId, doc, body }) => { /* … */ return { expiresAt, noDownload } }
})
```

The three reference conversions: `server/api/mcp/tokens/index.get.ts` (session only), `server/api/docs/[docId]/share-settings/index.put.ts` (document role, body, rate limit, conditional plan check), `server/api/files/[docId]/[fileId].get.ts` (anonymous, document JWT, params). `server/api/health/deep.get.ts` shows `allow.admin()`.

## What the wrapper does, in order

1. `instance: 'billing' | 'legalSurfaces' | 'customDomains'`: 404 `billing/disabled` / `legal/disabled` / `custom-domain/disabled` first. Then the rate limits with `phase: 'before-access'`.
2. The policy's `gate`: session (401), admin flag (403), service credentials, test mode (404). Then `recentLogin: true` (401 `auth/reauth-required`).
3. `params`, `query`: `safeParse`, 400.
4. `body`: `safeParse`, 400 (invalid JSON too).
5. The policy's `resolve`: object-level access (404 / 403).
6. `plan: { feature, message }`: 409 `plan/feature-unavailable`; the plan is the workspace's (`ctx.wsId`), else the document's (`ctx.doc`), else the user's.
7. `rateLimit` (one spec or a list): 429 with `error` (default `rate/limited`). `key`: `'user'`, `'ip'` (IPv4 or IPv6 /64), `'user+ip'` (`<userId>:<client key>`) or `(ctx, event) => string`. `phase: 'before-access'` (only with `key: 'ip'`) counts every request before the session and the object lookup: use it on anonymous-reachable routes whose 404 for an unknown id must not be free (`token.get`, `pdf.get`, file and brand files, `import.post`, SSO discovery).
8. `idempotency: { scope }`: `withIdempotency` with the user's id.
9. The handler: `ctx` = the policy's context + `params`, `query`, `body` (parsed outputs) + `event` (+ `rawBody()` for `body: 'raw'`, `parseBody()` for `body: lenientBody(schema)`: read when the handler asks, `null` instead of a 400 for unreadable JSON or a schema failure; for routes whose every answer must look the same, or that must act before reading the body, like the SAML ACS).

A step that must run between two of these (a cheap input check that must not spend a rate limit, as the invite route's address check) stays inline in the handler, limit included.

A validation failure answers `apiError(invalidCode ?? 'request/invalid', { field, fields })`: `field` is the first failing path, `fields` lists every issue (`path`, zod `issue` code, `minimum` / `maximum` / `format` / `expected`). The client turns `fields` into translated texts (`apiErrors.validation.<issue>`).

**Status changes to list in the PR** when they apply: a body-sourced document id is now checked for shape (400) before access (403/404); rate limits now run after access and input validation, so an over-limit caller with a bad body gets 400, not 429; an unconditional plan check moves after access and input.

## Form uploads: `body: 'multipart'`

A handler that accepts a file upload declares `body: 'multipart'`. The wrapper then does NOT read or parse the body (a size limit has to apply before anything is buffered), and the request type for the route is `FormData`, so the client calls `apiFetch('/api/import', { method: 'post', body: formData })` with a `FormData` it built (no `Content-Type` header: the browser adds the boundary).

The handler reads the body itself through a size-limited reader and refuses with a registered code: `readBodyWithLimit(event, maxBytes, 'import/file-too-large')` followed by `parseMultipart(event, body)` (`server/api/import.post.ts`; brand uploads use `readBrandUpload`). Check the file's presence, size and type after parsing. A multipart route still declares its `access`, `rateLimit` and (for anonymous-reachable routes) `phase: 'before-access'` like any other: only the body schema is replaced by the handler's own reader. Use `'custom'` for any other body the handler must read itself.

## Policies

| `access:` | Who passes | Context | Sessionless |
|---|---|---|---|
| `allow.public(reason)` | anyone; the session is never read (no cookie for anonymous callers) | `{ user: null, self: null }` | yes |
| `allow.public(reason, { session: 'optional' })` | anyone | `{ user \| null, self \| null }` | yes |
| `allow.user()` | a signed-in user | `{ user, self }` | no |
| `allow.admin()` | an instance admin (`users.is_admin`); 403 `admin/forbidden` before input is read | `{ user, admin, adminActor, self }` | no |
| `allow.workspace('member' \| 'editor' \| 'admin', o?)` | a role in `:wsId` (viewer < editor < admin). No role: 404 `workspace/not-found`; too low: 403 `o.deny` (default `auth/forbidden`). `ignoreSso: true` for the SSO settings (break-glass); `ssoHint: true` answers 403 `sso/required` with the sign-in link (returns to `/w/:wsId`). `orSelf: '<param>'`: when the (parsed, numeric) parameter is the caller, `need` is waived and a guest passes too (leaving); context adds `targetUserId`, `isSelf`, `role` may be `'guest'` | `{ user, wsId, role, workspaceAccess, self }` (`workspaceAccess` is null for a guest leaving) | no |
| `allow.doc(need, o?)` | see below | `{ user, docId, doc, state, actor, authz, docAccess, self }` | with `anonymous: true` |
| `allow.internal('secret' \| 'traefik-token' \| 'render-token')` | other containers: `X-Internal-Secret`; the Traefik provider token (`ctx.traefik` = settings, or null when the instance has no custom domains); a render token from `?docId=&t=` (`ctx.render`, plus a view proof `ctx.docAccess` held by `system('internal-render')`) | `{ user: null, … }` | yes |
| `allow.scim()` | a SCIM bearer token of an SSO connection. Every refusal (token, input, handler) leaves as an RFC 7644 Error object with `application/scim+json`: the policy carries `scimErrorFormat` (`server/utils/sso/scim.ts`); throw `scimError(status, detail, scimType?)` in the handler | `{ user: null, connection, workspaceAccess }` (held by `system('scim')`) | yes |
| `allow.testOnly({ session? })` | test mode only, 404 otherwise | `{ user \| null, self \| null }` | yes |
| `allow.custom(reason, { sessionless, check })` | whatever `check(event, input, gate)` returns; throw to deny. A non-sessionless custom policy still requires a session first. Flag every use in the PR | `check`'s result | as declared |

Document needs (`allow.doc`). Every one is decided by `shared/utils/documents/docPermissions.ts` on the row from `getDocWithActorRole` (`docStateOf` applies share expiry and SSO owner suspension). A missing document is 404 (`code: 'docs/not-found'`); a refusal is 403 `o.deny` (default `auth/forbidden`) or 401 `auth/required` where noted.

| need | Allows | Replaces |
|---|---|---|
| `file` | `decideFileAccess` (open docs: everyone; private / password: owner, members, doc JWT) | hand-built DocState + `decideFileAccess` |
| `activity` | `decideActivityAccess` | same for activity, diff, comment context |
| `write-content` | `canWriteDocContent` (what a writable token would allow); anonymous → 401 | `requireDocEditAccess` |
| `edit` | owner, workspace admin / editor | `canEditDoc` |
| `manage` | owner, workspace admin | `canManageDoc`, `requireShareManager`, `requirePublishManager` |
| `share-guests` | workspace admin / editor (members, not guests) of a workspace doc | `requireDocSharingAccess` |
| `delete` | `decideDocDelete` (anonymous docs: the creator browser's cookie); unauthenticated → 401 | the delete route's hand-built check |
| `lookup` | everyone who passes the gate; the handler decides (needs `reason`) | `token.get`, `meta.get`, `password.post`, per-field `meta.put` |

### Proofs in the context

The policy hands the handler capability proofs for exactly what it checked, and repo functions demand them (`server/repos/AGENTS.md` → Proofs, `docs/SECURITY-HARDENING.md` → Tenancy):

- `self` — `UserScope` of the signed-in user acting for themselves (null without a session).
- `docAccess` — `DocAccess` for the URL document at the need's level: `file` / `activity` → `view`, `write-content` → `write`, `edit`, `manage`, `share-guests` → `share`, `delete`. A `lookup` proof carries whatever the actor holds; narrow it per field with `docAccess.allows('write')`. Its actor is the user (or anonymous), never the document owner.
- `workspaceAccess` — `WorkspaceAccess` for `:wsId` at the caller's role.
- `adminActor` — `AdminActor` for instance-wide reads and writes (`adminActor.doc(id)`, `.workspace(id)`, `.user(id)`), recorded as the audit actor.

Pass these on; never mint a second proof for the same object in a handler. User-facing handlers may not import `system` (ESLint `markoto/no-system-actor-in-handlers`).

Options: `anonymous: true` (session optional; the route must be on the public allowlist), `jwt: true` (password holders' doc JWT) or `jwt: ['file-access']` (also the scoped preview / render tokens; only file routes), `docId: { from: 'body' | 'query', key? }` (default the `docId` path parameter), `deny`, `reason`.

`ctx.doc` is the authorization row and contains `anonCreatorKeyHash`: never return it. `defineApiHandler` refuses to compile when the response type contains a secret column name (`passwordHash`, `anonCreatorKeyHash`, `tokenHash`, …).

`sessionless` must match the middleware: a sessionless policy needs an entry in `server/utils/auth/publicRoutes.ts` (with a comment saying why), and a route on that list must declare a sessionless policy. `tests/unit/platform/apiRoutes.test.ts` checks both directions for every converted route.

## Recipe, per handler

1. `grep` the route in `tests/integration/` and note every asserted status, `data.code`, `data.field` and message regex.
2. Pick the policy from the tables above. If nothing fits, `allow.custom(reason, …)` and say why in the PR.
3. Move params, query and body into zod schemas in `shared/api/<domain>.ts` (`docs`, `ai`, `workspaces`, `brand`, `sso`, `billing`, `account`, `legal`, `platform`; create the file with its first schema). Names: `<verb><Resource>Body` / `…Query`. Query fields use `z.coerce.*`. No `.strict()`: clients that send extra fields keep working. A route that accepted a missing body uses `.nullish()` (or `.optional()`) and reads `body?.x`. Drop the `readBody<T>` casts and the `typeof` checks the schema now covers. Keep a route's existing 400 code with `invalidCode`.
4. Turn each unconditional gate into an option (`instance`, `recentLogin`, `plan`, `rateLimit`, `idempotency`). A gate that depends on the input or the current state stays inline in the handler (the share-settings plan check runs only when a restriction is added).
5. Replace every `createError` with `apiError(code, params)`. Keep each code a test asserts; use one code per distinct user-facing sentence. Code-less 401 / 403 / 404 become `auth/required`, `auth/forbidden`, `<ns>/not-found`; developer-only 400s become `request/invalid`.
6. Do not change the response shape and do not move database access.
7. Delete helpers that no longer have callers (knip reports them).
8. Convert the route's client call sites to `apiFetch` when you touch them (the app-side wave converts the rest).
9. Verify (below).

## Errors: adding or changing a code

A code is `<namespace>/<slug>`. The registry is `shared/api/errors/<namespace>.ts`, one file per namespace, merged in `shared/api/errors/index.ts`; the common codes (`request/invalid`, `request/too-large`, `auth/required`, `auth/forbidden`, `resource/not-found`, `rate/limited`, `internal`, `internal/forbidden`) are in `common.ts`.

```ts
export const shareErrors = defineErrors('share', {
  'expiry-too-far': { status: 400, params: z.object({ maxDays: z.number(), field: z.string().optional(), fields: z.array(fieldIssue).optional() }) },
  'not-allowed': { status: 403 }
})
```

- `status` is the HTTP status; `statuses` lists further ones a code is already sent with (pick one with `apiError(code, params, { status: 409 })`).
- `params` are the `data` fields next to `code` (`data` stays flat: `{ code, ...params }`). A code used as `invalidCode` must accept optional `field` and `fields`. Codes used as `deny` must be 403 without params.
- `apiError` type-checks the params; in test mode it also checks them at runtime and refuses an unregistered status.
- The text: add `apiErrors.<namespace>.<slug>` to **all six** `i18n/locales/errors/<locale>.json` (en, de, fr, es, ja, zh), in the namespace's block. A `{placeholder}` may only name a **required** param (the client falls back to the route's `messageKey` / message when a param is missing). vue-i18n syntax applies: no bare `@`, `|`, `{`, `}`. The English text is also the response `message` for API and MCP clients and logs.
- Non-English texts of the seeded codes are English for now (they were raw English before); translate them in the locale's block when you touch a namespace, consistent with the terms in `i18n/locales/<locale>.json`.

On the client, `useErrorHandler().extractError(err)` resolves the text: a per-occurrence key (plan feature or limit, provider refusal reason: the route's `messageKey`), the registered code's text, the route's `messageKey`, the raw message of an unregistered code, a status-based text. It reads a `$fetch` error's fields from the body's own `data` (`apiErrorData`, `app/utils/api/errors.ts`). A code whose text is fixed sends no `messageKey`: its text lives only under `apiErrors.<ns>.<slug>`.

## Typed client

```ts
import type { ApiRequest, ApiResponse } from '~/utils/api/client'
type IssuedToken = ApiResponse<'/api/mcp/tokens', 'get'>[number]
const tokens = await apiFetch('/api/mcp/tokens')
await apiFetch('/api/docs/:docId/share-settings', { method: 'put', path: { docId }, body: { noDownload: true } })
```

The route is the pattern (`:param`), not a template literal, so the response type survives. `path` is required exactly when the pattern has parameters; the body and query types come from the handler's schemas (`modules/api-contract.ts` generates `.nuxt/types/api-inputs.d.ts`; the raw dictation WebSocket accepts anything). No hand-written response interfaces and no `$fetch<T>` (linted).

## Enforcement

- `eslint.config.mjs`: in every handler file except the raw exceptions `defineEventHandler`, `readBody` / `getQuery` / `getRouterParam` / `requireDocId` / …, `requireValidatedUserSession` / `requireAdminUser` / …, and `createError` are errors. In `app/`, `$fetch<T>(…)` and `.data.message` reads are errors too.
- `tests/unit/platform/apiRoutes.test.ts`: every handler uses `defineApiHandler` or is a listed raw exception; `access` is an `allow.*` call with a reason where required; writes declare `body`; sessionless ⇔ public allowlist; no stale allowlist entry.
- `tests/unit/repoHygiene/apiErrorKeys.test.ts`: texts in all six locales, placeholders ⊆ required params, no orphan texts, every `code: '…'` literal under `server/` registered.
- `tests/unit/platform/defineApiHandler.test.ts`: the policy matrix against `docPermissions`, the order of the steps, fail-closed cases.
- `tests/nuxt/apiContract.typecheck.ts`: compile-time checks of inference, request types and the secret-key guard (run by `bun run typecheck`).

## Verify

`bun run typecheck`, `bun run lint` (no errors, and no budget growth: see CONTRIBUTING), `bun run test`, `bun run test:integration` on the batch's files (the full suite once per wave), `bun run knip`, `bun run depcruise`. In the integration output, look for `[api-error] unregistered code` lines.
