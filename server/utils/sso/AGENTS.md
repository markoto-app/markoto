# Per-workspace single sign-on

A workspace connects its own identity provider (OIDC or SAML) and optionally SCIM provisioning. Gated by the plan feature `sso` (on in the committed tiers; the hosted `infra/render-env.sh` turns it off below Business). User docs: `content/docs/workspace-admin/single-sign-on.md`.

Not the same as instance sign-in with OIDC (`server/utils/oidc/`, `NUXT_OAUTH_OIDC_*`). Workspace SSO reuses `oidc/client.ts` but has its own tables (`sso_connections`, `sso_domains`, `user_identities`, `sso_grants` in `server/db/schema/sso.ts`; repo `server/repos/sso.ts`), routes (`server/routes/auth/sso/[connectionId]/`, `server/routes/scim/v2/`, `server/api/workspaces/[wsId]/sso/`) and rules.

## Rules

- **Enforcement.** An `active` connection is always enforced. `ssoSatisfiedSql()` is part of `getMemberRole` and `getDocWithActorRole`, the two queries every access path uses (editor token, AI, MCP, knowledge, exports): no current grant, no role.
- `getMemberRoleIgnoringSso` is only for the SSO settings (`admin.ts#requireSsoAdmin`, the break-glass for admins), the sign-in itself, SCIM, and the "sign in with SSO" hints (`required.ts`). Never use it for the caller's own content access.
- **Owners are not exempt.** In an enforced workspace, owning a document counts only while the owner has an effective role there; `getDocWithActorRole` returns `ownerAccessSuspended` and the decisions in `shared/utils/documents/docPermissions.ts` honour it. Check ownership with `isEffectiveDocOwner`, never by comparing `ownerId`.
- **Grants** (`sso_grants`) are per user and workspace, valid 12 h, not per browser session, because background work (AI runs, MCP) has no session. While a grant is valid, the same account signed in another way also gets in. "Log out everywhere" voids every grant; SCIM deprovisioning takes effect at once. Removing a member (or leaving) deletes their grant, switching to another IdP (protocol, issuer or entity id) deletes the workspace's grants; a role change keeps the grant (the role is read live).
- **Draft → active** only through an admin's successful test sign-in (`?test=1`), which links the IdP identity to that admin. Any IdP setting change returns the connection to draft. Public-link documents stay public: enforcement covers what membership grants.
- **Who signs in** (`completeLogin.ts`): a known identity → its user (inactive = refused); test → the admin; an email in a domain VERIFIED by DNS TXT → the existing account with that address (linked) or a new one; otherwise `sso/not-provisioned`. Never run the `NUXT_ADMIN_USER_EMAILS` bootstrap for a customer IdP.
- **Joining** without an invite (JIT sign-in, SCIM create or reactivate, `membership.ts`) respects the member limit and seats, never buys a seat, uses an open invite for the address, and runs under a per-workspace advisory lock.
- **Outbound requests** (OIDC only) go through `urlPolicy.ts#createSsoFetch`: https, no internal names, loopback or metadata addresses, private addresses only with `NUXT_SSO_ALLOW_PRIVATE_URLS=true`, pinned address, no redirects, 1 MiB, 10 s. SAML makes no outbound request.
- **SAML** (`saml.ts`, `@node-saml/node-saml`): signed assertion, issuer, audience = `/auth/sso/<id>/metadata`, recipient, 30 s clock skew, `validateInResponseTo: always` against the request id from this browser's flow cookie, `rejectReplayedAssertions`. No IdP-initiated sign-in.
- **Flow cookie** (`flowCookie.ts`): HMAC-signed, httpOnly, path `/auth/sso`, 10 min, single use, bound to the connection; `SameSite=None; Secure` on https (SAML posts back cross-site), Lax on plain-http dev and test.
- **SCIM** (`scim.ts`): Users only; one bearer token per connection, shown once and stored as SHA-256; accepts Entra and Okta PATCH shapes. Deactivate removes membership, grant and the workspace AI key; delete removes the user from the workspace (the account stays); removing the last admin is 409. Routes declare `allow.scim()`, whose error format (`scimErrorFormat`) answers every refusal as a SCIM Error body.
- The OIDC client secret is encrypted with `platform/secretBox.ts` (purpose `sso-client-secret`, bound to the workspace id); the settings API never returns it, the certificate body or the SCIM token.
- Refused sign-ins redirect to `/auth/sso-error?code=sso/…` with fixed codes only. Audit actions are `sso.*` (`server/legal/auditActions.ts`).

## Tests

`tests/unit/workspaces/sso.test.ts` (domains, flow cookie, URL policy, SAML mapping) and `tests/integration/endpoints/sso.test.ts` (OIDC against the `oidc-test` mock IdP, SAML responses signed in-process by `tests/integration/setup/samlIdp.ts`, enforcement on every path, linking, JIT, SCIM).
