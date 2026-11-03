// Notice-and-action vocabulary (DSA Art.16 notices, Art.17 statements of
// reasons). Client-and-server safe: the report form, the admin queue and
// the notice emails all read these. Labels are i18n keys
// (`moderation.rule.<id>`, `moderation.action.<id>`); the notice emails
// carry their own short texts (server/utils/moderationNotices.ts).

/** Report categories the public form offers (stored on abuse_reports.category). */
export const REPORT_CATEGORIES = ['illegal_content', 'csam', 'copyright', 'harassment', 'spam', 'other'] as const
export type ReportCategory = typeof REPORT_CATEGORIES[number]

export function isReportCategory(value: unknown): value is ReportCategory {
  return REPORT_CATEGORIES.some(c => c === value)
}

/**
 * Category where the reporter's name + email are optional
 * (DSA Art.16(2)(c): not required for offences under Directive
 * 2011/93/EU, child sexual abuse material).
 */
export function contactOptionalFor(category: ReportCategory): boolean {
  return category === 'csam'
}

/** The rule a moderator cites in a decision (Terms + Acceptable Use rules). */
export const MODERATION_RULES = [
  'illegal_content',
  'csam',
  'phishing_or_fraud',
  'malware',
  'spam_or_seo',
  'copyright',
  'harassment_or_hate',
  'privacy_violation',
  'other_terms'
] as const
export type ModerationRule = typeof MODERATION_RULES[number]

export function isModerationRule(value: unknown): value is ModerationRule {
  return MODERATION_RULES.some(r => r === value)
}

/**
 * What the moderator did to the content.
 *   content_removed   — the document is deleted.
 *   access_restricted — the document is set to private: the owner keeps
 *                       access, nobody else; an anonymous document (no
 *                       owner) becomes unreachable.
 *   no_action         — reviewed, nothing changed (used with "dismissed").
 */
export const MODERATION_ACTIONS = ['content_removed', 'access_restricted', 'no_action'] as const
export type ModerationAction = typeof MODERATION_ACTIONS[number]

export function isModerationAction(value: unknown): value is ModerationAction {
  return MODERATION_ACTIONS.some(a => a === value)
}

/** Actions that affect the content and therefore owe the owner a statement of reasons. */
export function actionRestrictsContent(action: ModerationAction): boolean {
  return action !== 'no_action'
}

export const REPORT_BODY_MIN = 10
export const REPORT_BODY_MAX = 5000
export const REPORT_URL_MAX = 2000
export const REPORTER_NAME_MAX = 200
export const DECISION_EXPLANATION_MIN = 10
export const DECISION_EXPLANATION_MAX = 3000

const DOC_ID_SHAPE = /^[\w-]{1,64}$/

/**
 * The document id a reported location points at, or null. Accepts a full
 * URL or path containing `/d/<id>`, or a bare id. The host is not checked
 * (people paste the URL they see; moderators verify) — only the shape.
 */
export function docIdFromReportedLocation(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const match = /\/d\/([\w-]{1,64})(?:[/?#]|$)/.exec(trimmed)
  if (match?.[1]) return match[1]
  return DOC_ID_SHAPE.test(trimmed) ? trimmed : null
}
