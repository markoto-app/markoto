# Privacy registries

markoto keeps its privacy disclosures in TypeScript registries. The legal pages render from them, and tests check that they agree with each other. When a change touches personal data, update the registries in the same pull request as the code.

## The registries

| File | Holds | Rendered into |
|---|---|---|
| `server/legal/lawfulBasis.ts` | `PROCESSING_PURPOSES`: every processing purpose with `id`, `label`, GDPR Art. 6 `basis`, `dataCategories`, `retention` (days, or `until_deletion` / `legal_minimum` / `until_withdrawn`) and the `subProcessors` that touch it | the purposes table in the privacy policy (`{{processingPurposesTable}}` in `content/legal/privacy/en.md`) |
| `server/legal/subProcessors.ts` | `SUB_PROCESSORS`: `id`, `name`, `purpose`, `location`, `transferMechanism`, `dpfCertified`, `privacyPolicyUrl`, `dpaUrl` | `/legal/sub-processors` (`app/pages/legal/sub-processors.vue` via `GET /api/_internal/sub-processors`) |
| `server/legal/registryView.ts` | Deployment-aware views: with billing off, Stripe and the `billing` purpose are hidden; `google_ads`, `web_analytics` and `ad_conversion_measurement` show only where the analytics and ad-conversion features are on | used by both of the above |
| `server/legal/auditActions.ts` | `AUDIT_*` constants: the vocabulary of `audit_log.action` | not rendered |
| `shared/legal/versions.ts` | Version and effective date of each legal document, `CONSENT_VERSION`, the waitlist consent version, `LEGAL_DOCUMENT_LOCALES` | the legal pages and the onboarding gate |
| `shared/legal/entity.ts` | `resolveLegalEntity()`: the operating entity, overridable with `NUXT_LEGAL_*` env vars | `{{controllerName}}`, `{{privacyContactEmail}}` and the other placeholders in `content/legal/*/*.md` |

The legal Markdown is rendered per request by `server/api/_internal/legal/[slug].get.ts`, which substitutes the placeholders. Only `server/legal/` is server-only; `shared/legal/` is also read by the client.

`tests/unit/legal/registries.test.ts` checks that ids are unique, every sub-processor reference resolves, every basis and retention value is known, and `AUDIT_*` values are unique, lowercase and dot-separated. Add new cross-registry invariants there.

## What to update

### A feature processes personal data for a new purpose

1. Add an entry to `PROCESSING_PURPOSES`. Keep the `id` stable; give it a `label` (the table's first column).
2. Bump `PRIVACY_VERSION` and `PRIVACY_EFFECTIVE_DATE` in `shared/legal/versions.ts` and add a line to the version comment above them. Signed-in users whose accepted version is older are asked to accept the new one (`server/api/user/account-status.get.ts`).
3. Describe the purpose in `content/legal/privacy/en.md`; the other locales follow.
4. Include the new data in the data export (`server/utils/privacy/dataExport.ts`) and in account deletion (`server/utils/privacy/accountDeletionExecute.ts`).

Extending an existing purpose with new data categories or a longer retention is also a material change: update the entry and bump the version.

### A new third party receives personal data

1. Add an entry to `SUB_PROCESSORS`, and its `purpose` as `legal.subProcessors.purpose.<id>` in `i18n/locales/*.json` (the English text equal to the registry's sentence; `tests/unit/legal/registries.test.ts` checks that). The page shows the reader's language.
2. Add its id to the `subProcessors` list of every purpose that sends it data.
3. Bump `PRIVACY_VERSION`; sub-processor changes are material under GDPR Art. 28(2).
4. Update the prose in `content/legal/privacy/` and `content/legal/dpa/` where they name processors.

Services that run inside the markoto stack (markitdown, the renderer, the sync server, LiteLLM) are not sub-processors. A provider the user configures with their own key is not one either: the user chooses it, so it is covered by the `user_directed_ai_provider` purpose instead.

### A purpose needs consent for browser storage

markoto uses only essential storage today, so there is no cookie banner. To add consent-based storage: add the purpose to `CONSENT_PURPOSES` and `OPTIONAL_CONSENT_PURPOSES` in `server/utils/privacy/consentDecisions.ts`, bump `CONSENT_VERSION`, add a `PROCESSING_PURPOSES` entry, and build a banner with equally prominent Accept and Reject buttons.

### A new audited action

1. Add an `AUDIT_*` constant to `server/legal/auditActions.ts`: lowercase, dot-separated, namespace first (`account.delete_requested`, `mcp.token_issued`). `audit_log.action` is plain text, so no migration is needed.
2. Call `appendAuditEvent` (`server/repos/audit.ts`) with the constant. Pass the raw client IP as `actorIp`; the repo truncates it with `truncateIp` (/24 for IPv4, /48 for IPv6) before writing. Never put secrets or key material in `metadata`.
3. `appendAuditEvent` reports its own failures to Sentry and does not throw, so the user's action is not failed by a missing audit row.

### Not a registry entry

- Implementation details covered by an existing purpose (a new table for account data is still `account_authentication`).
- Logging that sees no user content: health probes, build metadata, secret rotation.

## Version bumps and tests

Test fixtures that seed policy acceptance import the constants from `shared/legal/versions.ts` (for example `tests/e2e/page-objects/Editor.ts`). Do the same in any new fixture: a hard-coded version number makes every seeded user hit the re-acceptance prompt after the next bump.
