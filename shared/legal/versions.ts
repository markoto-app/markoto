// Version anchors for our customer-facing legal documents +
// the consent record. Each is an integer; bumping ANY of these
// invalidates prior acceptance and re-prompts the user on next page
// load.
//
// Bump rules: these are legally load-bearing, not cosmetic:
//   - Privacy / ToS / DPA: bump on ANY material change. Typo fixes
//     and pure-translation edits do NOT bump (the authoritative English
//     text didn't change). Anything that adds/removes a processing
//     purpose, a sub-processor category, a retention period, a user
//     right, or a contact channel IS material.
//   - Consent: bump when adding a new processing purpose OR materially
//     changing what an existing purpose covers (e.g. analytics now
//     also tracks scroll depth). Don't bump for cosmetic banner copy.
//
// Effective date is informational only, the legal "from" date for
// each version. Stored alongside the version so the privacy page can
// show "Effective 2026-MM-DD" without a registry lookup.
//
// Authoritative locale is always English. Translations render with a
// "for convenience; English is authoritative" banner on non-EN locales.

// v5 (2026-10-26): new processing purpose `paid_plans_waitlist`.
// v6 (2026-10-26): new processing purpose `user_directed_ai_provider`
// (bring-your-own-key AI: content goes to the provider the user picks).
// v7 (2026-10-27): new processing purpose `workspace_invitations`
// (pending workspace invites keep the invitee's email until accepted,
// declined, revoked or expired after 14 days).
// v8 (2026-11-03): removed the product-analytics + session-replay
// purposes (never loaded) and the cookie banner; cookie list; Swiss FADP
// alongside GDPR with named transfer countries; backup retention; honest
// audit-log retention; anonymous documents (30 days, bot check, terms
// acceptance); precise age rule (16); AI training statements per provider.
// v9 (2026-11-09): billing data once paid plans are offered: Team /
// Business seats + billing admin, admins see members' monthly AI spend
// (not content), AI credits, Paid Plans Terms acceptance.
// v10 (2026-11-09): single sign-on through a workspace's own IdP + SCIM
// provisioning: identifier, link, last sign-in, active state.
// v11 (2026-11-09): workspace admins (audit-log plan feature) see and
// export that workspace's audit entries incl. names + truncated IPs.
// v12 (2026-11-09): workspace guests + document shares, per-person usage
// view for workspace admins.
// v13 (2026-11-10): publish as a web page + custom domains: the
// published copy, domain names, DNS checks, Let's Encrypt certificates
// (domain name public in Certificate Transparency logs).
// v14 (2026-11-17): cookieless visitor statistics (self-hosted Umami, 13
// months) and Google Ads conversion measurement without a Google script
// (click id of a converting visit, 90 days; Google Ads as recipient);
// the last day an account made a signed-in request
// (`users.last_active_on`, date only, overwritten), for active-user counts;
// the subscription history (start, change, cancellation, end of a plan).
export const PRIVACY_VERSION = 14
export const PRIVACY_EFFECTIVE_DATE = '2026-11-17'

// v2 (2026-10-26): free-only service, BYOK responsibilities, as-is/discontinuation clauses.
// v3 (2026-11-03): anonymous documents, acceptable-use section, DSA
// Art.14 moderation, liability cap + indemnity + forum, AI features,
// change notice, boilerplate.
export const TOS_VERSION = 3
export const TOS_EFFECTIVE_DATE = '2026-11-03'

// v2 (2026-10-26): members' own (BYOK) AI providers are not sub-processors.
// v3 (2026-11-03): Swiss-processor transfer section (FADP), backups,
// a full Annex I of technical and organisational measures.
export const DPA_VERSION = 3
export const DPA_EFFECTIVE_DATE = '2026-11-03'

// v2 (2026-11-03): DSA Art.16(2) notice elements, Art.16(5) receipt +
// decision notices, Art.17 statement of reasons, Art.20-style internal
// complaints, Art.18 notification of threats to life or safety.
export const ABUSE_POLICY_VERSION = 2
export const ABUSE_POLICY_EFFECTIVE_DATE = '2026-11-03'

// Paid Plans Terms: the extra terms for Pro / Team /
// Business and AI credits, accepted at checkout (not at onboarding, free
// users never see them). Acceptance is recorded per purchase in the audit
// log (`policy.accepted`, document `paid-terms`), not on the user row.
// v1 (2026-11-09): first version.
export const PAID_TERMS_VERSION = 1
export const PAID_TERMS_EFFECTIVE_DATE = '2026-11-09'

// The Impressum / provider-identification page (Swiss UWG Art. 3(1)(s),
// EU/DSA contact-point requirement). Facts come from shared/legal/entity.ts.
export const IMPRINT_VERSION = 1
export const IMPRINT_EFFECTIVE_DATE = '2026-07-03'

// v2 (2026-11-03): the `analytics` and `session_replay` purposes were
// removed (no such script was ever loaded) and with them the cookie
// banner: only essential storage remains, which needs no consent
// (ePrivacy Art.5(3)). `consent_log` keeps the v1 rows as the record.
export const CONSENT_VERSION = 2

// Version of the paid-plans waitlist consent text (the `waitlist.consentLabel`
// i18n string + the purpose described in `lawfulBasis.ts`). Stored on every
// `waitlist_signups` row together with `WAITLIST_CONSENT_TEXT_ID` so we can
// prove WHICH text a person agreed to (GDPR Art.7(1)). Bump on any material
// change to that text; existing rows keep the version they consented to.
// Independent of `CONSENT_VERSION` (the cookie banner), the waitlist
// consent is collected inline on the pricing page, not in the banner.
export const WAITLIST_CONSENT_VERSION = 1
export const WAITLIST_CONSENT_TEXT_ID = 'waitlist.consentLabel'

export const AUTHORITATIVE_LOCALE = 'en'

// Locales for which we publish a translated legal document. Other
// locales (ja, zh) fall back to English with a "translation pending"
// banner. UI strings are translated for all 6 locales independently
// in i18n/locales/.
export const LEGAL_DOCUMENT_LOCALES = ['en', 'fr', 'de', 'es'] as const
