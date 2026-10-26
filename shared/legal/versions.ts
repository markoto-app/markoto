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

// v5 (2026-10-26): new processing purpose `paid_plans_waitlist`.
// v6 (2026-10-26): new processing purpose `user_directed_ai_provider`
// (bring-your-own-key AI: content goes to the provider the user picks).
export const PRIVACY_VERSION = 6
export const PRIVACY_EFFECTIVE_DATE = '2026-10-26'

export const TOS_VERSION = 1
export const TOS_EFFECTIVE_DATE = '2026-05-04'

export const DPA_VERSION = 1
export const DPA_EFFECTIVE_DATE = '2026-05-04'

export const ABUSE_POLICY_VERSION = 1
export const ABUSE_POLICY_EFFECTIVE_DATE = '2026-05-04'

// The Impressum / provider-identification page (Swiss UWG Art. 3(1)(s),
// EU/DSA contact-point requirement). Facts come from shared/legal/entity.ts.
export const IMPRINT_VERSION = 1
export const IMPRINT_EFFECTIVE_DATE = '2026-07-03'

export const CONSENT_VERSION = 1

// Version of the paid-plans waitlist consent text (the `waitlist.consentLabel`
// i18n string + the purpose described in `lawfulBasis.ts`). Stored on every
// `waitlist_signups` row together with `WAITLIST_CONSENT_TEXT_ID` so we can
// prove WHICH text a person agreed to (GDPR Art.7(1)). Bump on any material
// change to that text; existing rows keep the version they consented to.
// Independent of `CONSENT_VERSION` (the cookie banner) — the waitlist
// consent is collected inline on the pricing page, not in the banner.
export const WAITLIST_CONSENT_VERSION = 1
export const WAITLIST_CONSENT_TEXT_ID = 'waitlist.consentLabel'

export const AUTHORITATIVE_LOCALE = 'en'

// Locales for which we publish a translated legal document. Other
// locales (ja, zh) fall back to English with a "translation pending"
// banner. UI strings are translated for all 6 locales independently
// in i18n/locales/.
export const LEGAL_DOCUMENT_LOCALES = ['en', 'fr', 'de', 'es'] as const
export type LegalDocumentLocale = (typeof LEGAL_DOCUMENT_LOCALES)[number]
