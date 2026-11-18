# server/utils

Server logic grouped by domain (`auth/`, `documents/`, `workspaces/`, `storage/`, `rendering/`, `billing/`, `litellm/`, `knowledge/`, `privacy/`, `platform/`, `publish/`, `brandKit/`, `designImport/`, `aiProviders/`, …). Nitro auto-imports from every sub-folder, so names must stay unique across folders. Background: `docs/contributing/server.md`, `docs/contributing/billing.md`, `docs/contributing/knowledge-base.md`. Own rules: `agentic/AGENTS.md`, `sso/AGENTS.md`.

## Platform

- Rate limits (`platform/rateLimit.ts`) check and record in ONE Lua script. Never split a limit into a read and a write round trip; a burst would pass it.
- Any app-side fetch of a URL a user or the AI supplied goes through `platform/safeFetch.ts` (resolve once, dial the checked IP, re-check every redirect, cap the body). Never `fetch(userUrl)`.
- Public upload endpoints read bodies with `readBodyWithLimit` (`platform/requestBodyLimit.ts`), not `readMultipartFormData`.
- Calls to markitdown send `markitdownAuthHeaders()` (`platform/markitdownAuth.ts`); markitdown has its own secret, never `INTERNAL_API_SECRET`.
- Email links use `emailLinkBaseUrl` (`platform/siteUrl.ts`), never the request Host or Origin.
- `isOverallHealthy` (`platform/healthProbes.ts`) decides whether Traefik keeps the node. Never let S3, the bucket CORS check or the embeddings check gate it.

## Storage and uploads

- Every presigned PUT for images and knowledge files targets a staging key (`storage/uploadKey.ts#stagingKeyFor`); confirm checks type and size, copies to the final key, deletes the staging key and sniffs the copy. Never presign a PUT for a final key.
- Never act on a client-supplied S3 key until it matches the caller's own `uploads` row (`repos/uploads.ts#findOwnUpload`); the bucket also holds backups and other users' files.
- Image quota reservations go through `repos/uploads.ts` (advisory lock + sum + insert in one transaction). Never check the quota and insert in separate steps.
- Redirect to a presigned URL with `sendPrivateRedirect` (`storage/privateRedirect.ts`), so the redirect is never cached.
- `storage/imageGc.ts` deletes an image only when every safety check holds for the whole retention window. Never loosen a check: a false "unreferenced" deletes an image a user can still see or restore.

## Documents and rendering

- Compute a past state by replaying the `yjs_updates` log up to the boundary id stored on the activity row (`documents/historyReplay.ts`), never against the latest row. All SQL on that table goes through `server/repos/yjsLog.ts`.
- Keep the 200-hunk cap in `documents/textDiff.ts` and the per-document advisory lock in `documents/restoreDoc.ts`.
- Before reading a live document's `yjs_updates` rows (duplicate, render), call `flushSyncDocument(docId)`; edits are flushed with a delay.
- Plan-gated theme features that Y.js can write (custom CSS, the workspace brand lock) are enforced at render time in `api/_internal/render-bootstrap.get.ts` and the editor's `renderTheme`. Never rely on the write-time check alone, and never delete stored CSS.
- A published page's HTML passes `publish/sanitizeSnapshot.ts` before it is stored.
- Brand-kit fonts are accepted only through `brandKit/fontInspect.ts#inspectFont`; don't add a font-parsing library.
- Design import parses uploaded files only inside the markitdown container (`designImport/extract.ts`), deletes the upload as soon as it is read, and sniffs the bytes it read.

## AI providers (bring your own key)

- Check every provider base URL with `aiProviders/urlPolicy.ts#checkProviderBaseUrl`, at save AND on every request; operator defaults use `OPERATOR_URL_POLICY`, never no policy.
- Only `aiProviders/store.ts` encrypts provider keys, and `toProviderView()` is the only shape that leaves the server. Never log or return a key.
- Show users the fixed sentence from `providerErrorMessage`, never upstream error text.

## Billing and LiteLLM

- Read the billing switch through `billing/billingMode.ts` on every call; never cache it at module scope.
- Never put `workspace_id` in a LiteLLM request body (reserved, LiteLLM answers 401); our metadata key is `markoto_workspace`.
- Stripe webhook handlers never throw on an unknown customer; let `dispatchStripeEvent` stash the event. Read version-dependent fields through `subscriptionPeriod`, `invoiceSubscriptionId` and `invoiceServicePeriod` (`billing/stripeEvents/stripeObjects.ts`). A new handled event type is one entry in the table of `billing/stripeEvents/eventHandlers.ts` (the list of handled types is derived from it); dedup and the stash stay in `billing/stripeWebhook.ts`.
- Fewer workspace seats are never credited, and workspace deletion calls `endWorkspaceBilling` before deleting anything. Keep both.
- A subscription change that costs money uses `PAID_CHANGE_PARAMS` (`pending_if_incomplete`) and checks `pendingPayment(updated)` before writing anything locally: a pending change is unpaid and must not unlock a plan, seats or budget.
- Checkout Sessions get their tax fields only from `checkoutTaxFields`; with Managed Payments on, no other tax, invoice, payment-method or customer-update parameter may be added.

## Privacy and email

- Run the account purge only from `account-deletion-sweep` (`privacy/accountDeletionSweep.ts`). A new table with user data must be covered by `privacy/accountDeletionExecute.ts` and the data export (`privacy/dataExport.ts`: sections that read tables directly; `privacy/dataExportSections.ts`: sections that read through repos or Stripe; the archive's README in `privacy/dataExportReadme.ts`).
- After the primary state has committed, send email with `safeSendTransactionalEmail` (`email/sendEmail.ts`). Pass `bodyContainsSecrets: true` for emails carrying single-use links, so stub mode never logs them.

## Explorer and imports

- Folders carry no permissions: decide access through the folder's workspace (`access/folderProof.ts`), never per folder. Background: `docs/contributing/explorer.md`.
- Deleting many documents (folder delete, bulk) goes through `documents/documentLifecycle.ts#deleteDocuments`, so every document gets its storage clean-up and the sync server's `notify-deleted`.
- Content the app writes to `yjs_updates` itself must be indexed (`documents/searchIndex.ts`); the sync server indexes everything it stores.

## Knowledge base

- `file-type` returning nothing is not a pass: text formats go through the printable-UTF-8 check in `storage/fileTypeGuard.ts`.
- `processKnowledge` re-checks the row after conversion and after embedding; keep both checks.
- Knowledge originals are deleted after processing. Never assume `workspace_knowledge.s3_key` points at a live object.
- The pending-upload slots fail closed when Valkey is down; keep that.
