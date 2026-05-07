# server/legal

Compliance registries — TypeScript source-of-truth for what we render into the privacy policy + sub-processor list, what audit-log actions exist, and which Article 6 lawful basis backs each processing purpose. **No code reads these to make runtime decisions** (we don't gate features on basis); the registries' job is to keep documentation, audit, and code in lockstep.

Adjacent: `shared/legal/` holds the version + entity registries (client-and-server-safe — both the privacy policy page and the onboarding gate read them). `server/legal/` is server-only because it imports nothing client-side and the lawful-basis disclosure should not ship to the browser.

## Files

| File | What it owns |
|---|---|
| `lawfulBasis.ts` | `PROCESSING_PURPOSES` — every processing purpose we run, paired with its GDPR Art.6 basis, data categories, retention, and sub-processor refs. Rendered into `/legal/privacy` verbatim. |
| `subProcessors.ts` | `SUB_PROCESSORS` — the sub-processor table. Rendered into `/legal/sub-processors`. |
| `auditActions.ts` | `AUDIT_*` constants — the canonical action vocabulary for `audit_log.action`. |

`shared/legal/versions.ts` (re-exported wherever needed):

| Symbol | Bumps when |
|---|---|
| `PRIVACY_VERSION` | Material change to the privacy policy. Typo + translation-only edits don't bump. |
| `TOS_VERSION` | Material change to the ToS. |
| `DPA_VERSION` | Material change to the DPA. Workspace owners get a re-acceptance modal. |
| `ABUSE_POLICY_VERSION` | Material change to the abuse policy. |
| `CONSENT_VERSION` | New processing purpose OR existing purpose materially expanded. |
| `AUTHORITATIVE_LOCALE` | `'en'` — never bump unless the operating entity moves jurisdictions. |
| `LEGAL_DOCUMENT_LOCALES` | The set of translated locales a given doc is rendered for. |

`shared/legal/entity.ts` exposes `resolveLegalEntity()` — request-time resolver that overlays env vars (`NUXT_LEGAL_*`) over the in-source defaults (Latent Labs GmbH, Zurich). The legal markdown sources (`content/legal/*/{locale}.md`) reference `{{controllerName}}` / `{{controllerAddress}}` / `{{privacyContactEmail}}` / `{{abuseContactEmail}}` / `{{governingLaw}}`; the server renderer substitutes per request.

## Rules of engagement

### Adding a processing purpose

1. Add a row to `PROCESSING_PURPOSES` with `{id, label, basis, dataCategories, retention, subProcessors, description}`. The `id` is referenced by audit / docs and must be stable.
2. **Bump `PRIVACY_VERSION`** in `shared/legal/versions.ts`. The version-bump invalidates all prior privacy-policy acceptance, so the next visit re-prompts.
3. If the purpose is consent-backed (analytics, session_replay), also bump `CONSENT_VERSION` and add the matching consent purpose to `ConsentBanner.vue`'s purpose list.
4. Update `content/legal/privacy/en.md` to reflect the new row in prose. Translations follow.

The 13 current purposes (truncated): `account_authentication`, `document_storage`, `collaboration_sync`, `comments_and_mentions`, `ai_assistance`, `workspace_knowledge_rag`, `billing`, `fraud_and_abuse_prevention`, `security_audit_log`, `transactional_email`, `product_analytics`, `session_replay`, `error_monitoring`. Read `lawfulBasis.ts` for the full table.

### Adding a sub-processor

1. Add a row to `SUB_PROCESSORS` with `{id, name, role, dataCategories, regions, transferMechanism, dpaUrl}`.
2. **Bump `PRIVACY_VERSION`**. Sub-processor changes are material under GDPR Art.28(2).
3. Wire the new processor into the `subProcessors` field of every `PROCESSING_PURPOSES` row that touches it (often more than one).
4. Update `content/legal/privacy/en.md` AND `content/legal/sub-processors.md` if the prose names them.

Current set (truncated): `ovh_postgres`, `ovh_object_storage`, `mistral_ai`, `jina_ai`, `bfl`, `google_oauth`, `github_oauth`, `stripe`, `resend`. **Markitdown was deliberately removed** from the list — it's a self-hosted FastAPI sidecar processing uploads in-process; it's not a third-party data flow.

**Phase 6 sub-processor swap.** `google_gemini` + `google_speech_to_text` were removed when Phase 6 collapsed every AI surface onto LiteLLM. Their replacements:

| Sub-processor | Role | Region | Transfer mechanism |
|---|---|---|---|
| `mistral_ai` (Mistral AI SAS, Paris) | Text generation (Mistral Small) + voice transcription (Voxtral Mini Transcribe + Voxtral Realtime live dictation) | EU | `intra_eu` — no DPF/SCC needed |
| `jina_ai` (Jina AI GmbH, Berlin) | Embeddings (jina-embeddings-v5-text-nano, 768-d native) + web-search content extraction (Jina Reader) | EU | `intra_eu` |
| `bfl` (Black Forest Labs GmbH) | Image generation via FLUX.2 [pro], EU-pinned at `api.eu2.bfl.ai` | EU | `intra_eu` |

`PROCESSING_PURPOSES` updated in lockstep: `ai_assistance` → `subProcessors: ['mistral_ai', 'jina_ai', 'bfl']`; `workspace_knowledge_rag` → `subProcessors: ['jina_ai', 'ovh_postgres', 'ovh_object_storage']`. This was a material change under GDPR Art.28(2), so `PRIVACY_VERSION` bumped 2 → 3 (`PRIVACY_EFFECTIVE_DATE = '2026-05-06'`); every prior privacy-policy acceptance was invalidated and existing users see the re-acceptance modal on next visit.

### Adding an audit action

1. Add a `AUDIT_*` constant in `auditActions.ts` (lowercase, dot-separated, namespace-first: `account.delete_requested`, `consent.recorded`, etc.).
2. **No migration needed** — `audit_log.action` is plain text. Just `import { AUDIT_FOO_BAR } from '~~/server/legal/auditActions'` at the call site and pass to `appendAuditEvent`.
3. **Always pseudonymise the IP** at the call site via `truncateIp(rawIp)` from `server/repos/audit.ts` before passing to `actorIp`. The repo trusts what it gets.
4. Audit writes are best-effort — `appendAuditEvent` swallows + Sentry-captures internally. The user's primary action has already committed; failing the request because the audit row didn't write would be confusing.

Privacy-relevant categories already wired:
- `account.*` — delete requested/cancelled/executed, export requested/completed/failed, age confirmed
- `consent.recorded`, `policy.accepted`
- `abuse.reported` / `acknowledged` / `actioned` / `dismissed`
- `admin.granted` / `admin.revoked`

### When NOT to add a registry entry

- **Implementation details.** "Calls Postgres for the user table" isn't a processing purpose; `account_authentication` covers it.
- **Logging or observability that doesn't see user content.** Health probes, build-time metadata, secret-rotation events. Audit-log them if they're operationally interesting; don't list them as a processing purpose.
- **Internal-only sub-processors.** Markitdown, the Playwright renderer sidecar, the sync server — all run on our infra. They're not separate processors.

## Why this lives here, not in markdown

The legal markdown documents (`content/legal/*/*.md`) are the user-facing surface; the registries here are the source-of-truth that those documents must match. Drifting the two apart is the failure mode we're guarding against:

- A registry entry without prose is a code change that hasn't shipped legal-doc updates → the audit log records something the privacy page doesn't disclose.
- Prose without a registry entry is a privacy promise the code doesn't enforce → operationally untrue.

Tests in `tests/unit/legal/registries.test.ts` enforce the cross-registry invariants:
- Every `PROCESSING_PURPOSES.subProcessors` ref resolves to a `SUB_PROCESSORS.id`.
- All ids are unique within their registry.
- `AUDIT_*` constants don't collide.

Add to that test file when you add a new invariant.

## Gotchas

- **Bumping a `_VERSION` constant cascades to test fixtures.** Phase 6 lesson: bumping `PRIVACY_VERSION` 2 → 3 mid-phase silently broke 32 flow tests (~15 s each) because `tests/e2e/page-objects/Editor.ts` (`Editor.loginAsTestUser`) AND the `delete-account-with-consequences` spec hard-coded `2/1/1` for the `privacy/tos/dpa _version_accepted` columns when seeding test users. The OnboardingGate then flagged every seeded user as "needs re-acceptance" and overlay-blocked clicks. **Both files now `import { PRIVACY_VERSION, TOS_VERSION, DPA_VERSION } from 'shared/legal/versions'` and parametrize the SQL** so future bumps stay in sync automatically. If you add another fixture that seeds policy-acceptance columns, follow the same pattern — never hardcode the integers.

## Related

- `server/repos/audit.ts` — append-only writer; `truncateIp` lives here.
- `server/utils/accountDeletion*.ts` — uses `AUDIT_ACCOUNT_*`.
- `server/utils/dataExport*.ts` — uses `AUDIT_ACCOUNT_EXPORT_*`.
- `server/api/abuse-reports.post.ts`, `server/api/admin/abuse-reports/[reportId].patch.ts` — use `AUDIT_ABUSE_*`.
- `server/api/_internal/legal/[slug].get.ts` — server-side renderer with `{{...}}` substitution against `resolveLegalEntity()`.
- `app/components/legal/AGENTS.md` — UI surfaces that read these (banner, gate, deletion modal).
