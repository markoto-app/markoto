# API Routes

`server/api/` → `/api/*`. `server/routes/` → `/`. `server/auth/` is unreachable.

**Auth:** `GET /auth/github`, `GET /auth/google`, `GET /api/_auth/session`

**Meta:** `GET /api/health` (cached aggregator probing Postgres + Valkey + sync + renderer + markitdown; 5s healthy / 2s degraded TTL), `GET /api/health/deep` (auth-required, no cache, returns per-component `{status, latencyMs, error?}`), `GET /api/version` (SPA staleness)

**Documents:** `POST /api/docs` (anon OK; accepts optional `workspaceId` + new-doc-dialog fields `title`/`description`/`audience`/`language`/`templateId`/`themePreset`, all validated against the registries — empty body = legacy zero-config flow), `GET/PUT /api/docs/:id/meta` (PUT validates description ≤500, audience enum, language ≤50; owner-only), `DELETE /api/docs/:id` (`canManageDoc`), `GET /api/docs/:id/token` (consolidated: token + readOnly + requiresPassword + forbidden + accessMode + ownerId + workspaceId + workspaceRole + theme + description/audience/language for editor hydration + `initialBody` (server-rendered template body, locale-matched on doc.language) + templateId), `GET /api/docs/:id/activity`, `GET /api/docs/:docId/activity/:activityId/diff` (Tier 1 — replays Y.js up to before/after boundaries, returns `structuredPatch` hunks; whitelisted public, auth via `decideActivityAccess`), `GET /api/docs/:docId/activity/:activityId/comment-context` (Tier 1 comment expansion; same auth shape), `POST /api/docs/:docId/activity/:activityId/restore` (Tier 2 — edit-access required; calls `restoreDocToYjsId` then writes `restore` activity row; atomic on failure), `POST /api/docs/:id/password`, `PATCH /api/docs/:id/workspace` (move; `canManageDoc` on source + admin/editor on target), `POST /api/docs/:id/duplicate` (clone row + Y.js state with URL rewrite + S3 assets; `canEditDoc` on source, new owner = duplicator; description/audience/language/templateId copy through unchanged; honours `Idempotency-Key` via `withIdempotency` so a network retry mid-clone doesn't produce two), `GET /api/docs/:id/pdf` (server-rendered PDF via `renderClient.renderDocument` → renderer sidecar → S3 manifest cache; rate-limited 10/IP/min, view-access required).

**Internal (sync→app, `X-Internal-Secret`):** `POST /api/internal/activity` (sync→app activity logging; the sync-server stamps `yjsDocIdBefore`/`yjsDocIdAfter` boundary ids per row so Tier 1 diffs + Tier 2 restores can replay; returns `{ success: true, logged: false, deduped: true }` when the cross-instance partial-unique-index race fires and the second insert is a no-op), `POST /api/internal/comments-snapshot` (per-thread state snapshot triggered on every comment.* mutation; serialised by `pg_advisory_xact_lock(hashtext(docId))` so concurrent writes don't both read the same `latest_id` and produce identical phantom snapshots), `GET /api/_internal/render-bootstrap` (renderer-token-gated; serves the doc's initial Y.js state + theme to the renderer's headless print page).

**User:** `GET /api/user/documents`, `GET /api/user/workspaces`, `GET /api/user/recent`, `GET /api/user/account-status` (single fetch behind `useAccountStatus()` — returns ageConfirmedAt + per-document `*_version_accepted` + `deletion_requested_at` + `isAdmin` + workspace fates from `planAccountDeletion`).

**Privacy / account lifecycle (login required):** `POST /api/user/onboarding/accept` (writes Privacy + ToS + age via `applyOnboardingAcceptance` in one update), `POST /api/user/dpa/accept` (workspace-owner-only DPA acceptance), `POST /api/user/delete` (flips `deletion_requested_at`, audits, fires "deletion scheduled" email), `POST /api/user/delete-cancel` (one path segment — NOT `/delete/cancel`; nulls the column + audits `account.delete_cancelled`). Hard purge is async via `accountDeletionSweep.ts`, NOT inline.

**Data export (login required):** `POST /api/user/data-export` (enqueues a `data_export_jobs` row, audits `account.export_requested`; rate-limited), `GET /api/user/data-export/history` (lists user's recent jobs with status + S3 download URL when `ready`). The worker (`dataExportWorker.ts` plugin) drains queued rows; expiry sweeper flips `ready` → `expired` past 7-day TTL.

**Consent / cookies (no session — anon-id-keyed):** `GET /api/consent?anonId=…` (returns latest row for the anon-id), `POST /api/consent` (append-only insert; carries optional `userId` for post-login bridge). The `markoto-anon-id` cookie is the consent identity, NOT the user.

**Abuse reporting:** `POST /api/abuse-reports` (login required, 10/user/hour; DSA Art.16 notice-and-action submission; `docId` is free-form text not FK; reporter email + truncated IP + UA hash captured; best-effort operator email via Resend on every submit).

**Admin (admin-only via `requireAdminUser`):** `GET /api/admin/abuse-reports` (triage queue with reporter + actioner joins via `aliasedTable`), `PATCH /api/admin/abuse-reports/:reportId` (status change → audit `abuse.actioned` / `.dismissed`).

**Legal documents (no session):** `GET /api/_internal/legal/:slug` (renders markdown from `content/legal/:slug/<locale>.md` with `{{controllerName}}` / `{{controllerAddress}}` / `{{privacyContactEmail}}` / `{{abuseContactEmail}}` / `{{governingLaw}}` substitution against `resolveLegalEntity()`), `GET /api/_internal/sub-processors` (renders `SUB_PROCESSORS` registry as JSON for the `/legal/sub-processors` page).

**Files:** `POST /api/upload/request` (presigned PUT), `POST /api/upload/confirm` (HEADs the S3 object then runs `file-type` magic-byte sniff against the declared MIME — bypass attempts get 415 + orphan delete), `GET /api/files/:docId/:fileId` (302 → presigned GET, access-controlled)

**Import:** `POST /api/import` (DOCX/PDF/PPTX/XLSX/HTML/EPUB → markdown, 50MB, public)

**Workspaces (login required):** `POST /api/workspaces` (enforces per-user cap), `GET/PUT/DELETE /api/workspaces/:wsId`, `POST /api/workspaces/:wsId/members`, `PATCH/DELETE /api/workspaces/:wsId/members/:userId`

**Workspace knowledge (login required + membership):**
- `POST /api/workspaces/:wsId/knowledge/upload-request` — admin/editor; rate-limited + cap-checked; mints 300s presigned PUT + reserves Valkey inflight slot
- `POST /api/workspaces/:wsId/knowledge/confirm` — HEAD + `file-type` magic sniff + advisory-locked cap recheck + row insert; kicks `processKnowledge` fire-and-forget; always releases inflight slots
- `GET /api/workspaces/:wsId/knowledge` — any member; returns items (sans `markdown_cache`) + aggregate usage/cap info
- `DELETE /api/workspaces/:wsId/knowledge/:knowledgeId` — admin or editor-who-uploaded; cascades chunks via FK + best-effort S3 delete

**AI (login required):** `POST /api/ai/prompt` (returns `{sessionId}`; also handles selection-scoped rewrites since phase 5 collapsed the separate rewrite path into this one), `POST /api/ai/abort` (initiator only, 403 otherwise), `POST /api/ai/transcribe` (voice → text via Cloud STT sync; `{text, inaudible}`), `POST /api/ai/dictate/token` (mints 60s JWT for the dictation WS), `WS /api/ai/dictate` (live dictation relay — JWT auth via first message, NOT query string), `POST /api/docs/:docId/comments/:commentId/trigger-ai` (AI ↔ comment thread via `@ai` mention; see `server/utils/agentic/AGENTS.md`)

**Billing (login required):** `POST /api/billing/checkout` (Stripe Checkout session for upgrade flow), `POST /api/billing/portal` (Stripe billing-portal session for plan management).

**Webhooks (no session — signature-verified):** `POST /api/webhooks/stripe` — verifies `Stripe-Signature` against `NUXT_STRIPE_WEBHOOK_SECRET`, then dispatches via `dispatchStripeEvent`. Replay-protected via `processed_webhook_events` (atomic INSERT ON CONFLICT DO NOTHING short-circuits replays). Out-of-order events (`subscription.*` / `invoice.*` arriving before the binding `checkout.session.completed`) are stashed in `pending_stripe_events` and drained in receive order on the eventual checkout. Always responds 200 to Stripe even on internal handler errors when the row is already deduped, so Stripe stops retrying. See `server/utils/AGENTS.md`.

Auth guard: see `server/AGENTS.md` for whitelist conventions.

**Audit-log readers:** none in user-facing UI. `appendAuditEvent` is fire-and-forget from privileged endpoints (workspace delete, member role change, member removal, account-deletion lifecycle, abuse-report lifecycle, admin grant/revoke, consent recorded, policy accepted) and several sweepers. The `/api/admin/abuse-reports` endpoints DO read audit indirectly (the actioner column is FK'd to `users` so the join surfaces who triaged); a broader forensic admin UI is future work — when added, gate on `requireAdminUser` from `server/utils/adminAccess.ts`.
