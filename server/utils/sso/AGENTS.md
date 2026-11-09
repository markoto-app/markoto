# Per-workspace single sign-on (WP14)

A workspace connects its own identity provider (OIDC or SAML) and, optionally, SCIM provisioning. Business on markoto.app (`sso` plan feature, `TIER_{FREE,PRO,TEAM}_FEATURE_SSO=false` in `infra/render-env.sh`); every workspace on a self-hosted instance (committed tiers have it on). User docs: `content/docs/account/single-sign-on.md`.

Not to be confused with the **instance** OIDC sign-in (`server/utils/oidc/`, `NUXT_OAUTH_OIDC_*`, the operator's IdP, `users.oidc_issuer/subject`). Per-workspace SSO reuses its protocol layer (`oidc/client.ts`) but has its own tables, routes and rules.

## Data (`server/db/schema.ts`, repo `server/repos/sso.ts`)

| Table | What |
|---|---|
| `sso_connections` | one per workspace: protocol, IdP settings (OIDC client secret AES-256-GCM via `litellm/tokenCrypto`; SAML cert pasted PEM), `status` draft / active, `default_role`, `scim_token_hash` |
| `sso_domains` | email domains + TXT verification token; verified by ONE workspace (partial unique index) |
| `user_identities` | (connection, subject) → user; `scim_external_id`, `active`; a SCIM-created one has subject `scim:<externalId>` until the first real sign-in takes it over |
| `sso_grants` | (user, workspace) → valid until `expires_at` (12 h), for `session_epoch` |

## Rules

- **Enforcement:** an `active` connection is ALWAYS enforced. `ssoSatisfiedSql()` is part of `getMemberRole` AND `getDocWithActorRole` — the two queries every access path goes through (editor token, AI, MCP, knowledge, exports). No grant → no role. `getMemberRoleIgnoringSso` exists ONLY for: the SSO settings (`admin.ts#requireSsoAdmin` — the break-glass), the sign-in itself, SCIM, the "sign in with SSO" hints (`required.ts`), and admin actions about ANOTHER member (removal). Never use it for the caller's own content access.
- **Grants** are per user + workspace, not per browser session (background work — AI runs, MCP — has no session to check). Known trade-off: while a grant is valid, the same account signed in via GitHub in another browser also gets in. "Log out everywhere" (epoch bump) voids every grant; deprovisioning at the IdP takes effect within 12 h, at once with SCIM.
- **Draft → active only by an admin's successful test sign-in** (`?test=1`, links the IdP identity to THAT admin). Any IdP setting change returns the connection to draft. A public-link document (`open-edit` / `open-view`) stays public — enforcement covers what membership grants.
- **Who is who** (`completeLogin.ts`): known identity → its user (inactive = refused); test → the admin; email in a VERIFIED domain → existing account with that address (linked) or a new one; otherwise `sso/not-provisioned`. Never `NUXT_ADMIN_USER_EMAILS` bootstrap from a customer IdP.
- **Joining** without an invite (JIT sign-in, SCIM create/reactivate: `membership.ts`): member limit + seats, never buys a seat, uses an open invite for the address; per-workspace advisory lock.
- **Outbound (OIDC only):** every request to the customer's IdP goes through `urlPolicy.ts#createSsoFetch` (openid-client `customFetch`): https, no internal names / loopback / metadata, private only with `NUXT_SSO_ALLOW_PRIVATE_URLS=true` (self-host on-prem IdPs, the test stack), pinned address, no redirects, 1 MiB, 10 s. SAML makes no outbound request (cert pasted, browser carries the messages).
- **SAML** (`saml.ts`, `@node-saml/node-saml`): signed assertion, issuer, audience = `/auth/sso/<id>/metadata`, recipient, time (30 s skew), `validateInResponseTo: always` with a Valkey cache that at the ACS only knows the request id from THIS browser's signed flow cookie (GETDEL), `rejectReplayedAssertions`. No IdP-initiated sign-in.
- **Flow cookie** (`flowCookie.ts`): HMAC-signed, httpOnly, path `/auth/sso`, 10 min, single use, bound to the connection; `SameSite=None; Secure` on https (SAML posts back cross-site), Lax on plain-http dev/test.
- **SCIM** (`scim.ts`, routes `server/routes/scim/v2/`): Users only, bearer token per connection (shown once, SHA-256), Entra (`"False"` strings, `path`) and Okta (value objects) PATCH shapes, deactivate = membership + grant + workspace AI key out, delete = out of the workspace (the account stays), last admin → 409, errors as SCIM Error bodies (`defineScimHandler`).

## Routes

| Route | |
|---|---|
| `GET /auth/sso/:id` (`?test=1`, `?returnTo=`) | start (OIDC authorize / SAML AuthnRequest) |
| `GET /auth/sso/:id/callback` | OIDC |
| `POST /auth/sso/:id/acs` | SAML |
| `GET /auth/sso/:id/metadata` | SAML SP metadata (public) |
| `GET|PUT|DELETE /api/workspaces/:wsId/sso` | settings (admins) |
| `POST /api/workspaces/:wsId/sso/domains`, `POST …/domains/:id/verify`, `DELETE …/domains/:id` | domains |
| `POST|DELETE /api/workspaces/:wsId/sso/scim-token` | SCIM token |
| `POST /api/auth/sso/discover` | email → sign-in link (public, 20/min) |
| `/scim/v2/Users[/:id]`, `ServiceProviderConfig`, `ResourceTypes` | SCIM |

Refused sign-ins land on `/auth/sso-error?code=sso/…` (fixed codes only). Audit actions `sso.*` (`server/legal/auditActions.ts`).

## Tests

`tests/unit/sso.test.ts` (domains, flow cookie, URL policy, SAML mapping); `tests/integration/endpoints/sso.test.ts` — OIDC against the real `oidc-test` mock IdP (published on the test network's private address, `ssoMockIdpBase()`), SAML with responses signed in-process (`tests/integration/setup/samlIdp.ts`, key pair from openssl per run — forged / misdirected / expired / unsolicited / replayed responses), enforcement on every path, linking, JIT, SCIM.
