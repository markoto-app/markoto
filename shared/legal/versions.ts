// Version anchors for our four customer-facing legal documents +
// the cookie-consent banner. Each is an integer; bumping ANY of these
// invalidates prior acceptance and re-prompts the user on next page
// load.
//
// Bump rules — these are legally load-bearing, not cosmetic:
//   - Privacy / ToS / DPA: bump on ANY material change. Typo fixes
//     and pure-translation edits do NOT bump (the authoritative English
//     text didn't change). Anything that adds/removes a processing
//     purpose, a sub-processor category, a retention period, a user
//     right, or a contact channel IS material.
//   - Consent: bump when adding a new processing purpose OR materially
//     changing what an existing purpose covers (e.g. analytics now
//     also tracks scroll depth). Don't bump for cosmetic banner copy.
//
// Effective date is informational only — the legal "from" date for
// each version. Stored alongside the version so the privacy page can
// show "Effective 2026-MM-DD" without a registry lookup.
//
// Authoritative locale is always English. Translations render with a
// "for convenience; English is authoritative" banner on non-EN locales.

export const PRIVACY_VERSION = 4
export const PRIVACY_EFFECTIVE_DATE = '2026-07-03'

export const TOS_VERSION = 1
export const TOS_EFFECTIVE_DATE = '2026-05-04'

export const DPA_VERSION = 1
export const DPA_EFFECTIVE_DATE = '2026-05-04'

export const ABUSE_POLICY_VERSION = 1
export const ABUSE_POLICY_EFFECTIVE_DATE = '2026-05-04'

export const CONSENT_VERSION = 1

export const AUTHORITATIVE_LOCALE = 'en'

// Locales for which we publish a translated legal document. Other
// locales (ja, zh) fall back to English with a "translation pending"
// banner. UI strings are translated for all 6 locales independently
// in i18n/locales/.
export const LEGAL_DOCUMENT_LOCALES = ['en', 'fr', 'de', 'es'] as const
export type LegalDocumentLocale = (typeof LEGAL_DOCUMENT_LOCALES)[number]
