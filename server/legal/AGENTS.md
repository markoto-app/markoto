# Privacy registries — agent rules

What the registries hold and the full checklists: `docs/contributing/privacy-registries.md`.

- Any new processing of personal data (new purpose, new data category, longer retention) needs an entry in `PROCESSING_PURPOSES` (`lawfulBasis.ts`). The privacy policy renders this table; code without an entry is an undisclosed processing.
- Any new third party that receives personal data needs an entry in `SUB_PROCESSORS` (`subProcessors.ts`) and its id on every purpose that sends it data. Services inside the markoto stack and providers the user configures with their own key are not sub-processors.
- Such a change bumps `PRIVACY_VERSION` and `PRIVACY_EFFECTIVE_DATE` in `shared/legal/versions.ts` (with a line in the version comment) and updates `content/legal/privacy/en.md`. Signed-in users are then asked to accept again.
- New personal data must also appear in the data export (`server/utils/privacy/dataExport.ts`) and be handled by account deletion (`server/utils/privacy/accountDeletionExecute.ts`).
- Purposes that exist only with billing on are hidden by `registryView.ts`; keep that list in step when you add billing-only entries.
- Add new audit actions as `AUDIT_*` constants in `auditActions.ts`: lowercase, dot-separated, namespace first (`account.delete_requested`). Some older call sites still pass literals such as `'doc.deleted'`; follow the same naming.
- Pass the raw client IP to `appendAuditEvent`; it truncates it. Never put secrets, tokens, token hashes or key material in audit `metadata`.
- Do not fail a user's request because an audit write failed; `appendAuditEvent` already reports and swallows its errors.
- Consent-based browser storage needs `CONSENT_PURPOSES` + `OPTIONAL_CONSENT_PURPOSES` (`server/utils/privacy/consentDecisions.ts`), a `CONSENT_VERSION` bump and a banner. Today there is only essential storage and no banner.
- Test fixtures that seed policy acceptance import the version constants from `shared/legal/versions.ts`; never hard-code version numbers.
- Add new cross-registry invariants to `tests/unit/legal/registries.test.ts`.
