/**
 * Closed enum of writing registers, each resolving to a curated tone
 * fragment that gets injected into the AI system prompt every turn.
 *
 * Why a closed enum (not free text):
 *   - Free-form audience steering belongs in the user's prompt
 *     ("write this as a marketing piece"). Audience is for DURABLE tone
 *     that survives every prompt without re-typing.
 *   - The fragments are tuned English. Letting users write their own
 *     would let them silently break the system-prompt contract (e.g.
 *     "ignore previous instructions"). The enum is the trust boundary.
 *
 * Why fragments live in code (not i18n locale files):
 *   - The AI is multilingual at the OUTPUT layer — its output language
 *     is driven by the document's `language` field, not the prompt's
 *     language. Translating these fragments would dilute carefully-
 *     tuned wording without buying anything.
 *   - The user-facing `label` and `description` ARE i18n'd via the
 *     `audiences.<id>.label` / `audiences.<id>.description` keys.
 */

export const AUDIENCES = {
  technical: {
    label: 'audiences.technical.label',
    description: 'audiences.technical.description',
    promptFragment: `Write for an engineering audience. Be precise, concise, and concrete. Lead with the technical claim, then justify it. Use code blocks for code, tables for comparisons, and exact terminology over euphemism. Never apologize, never hedge with "I think". Assume the reader can read a stack trace and a function signature. Skip background that any working engineer already knows.`
  },
  marketing: {
    label: 'audiences.marketing.label',
    description: 'audiences.marketing.description',
    promptFragment: `Write for prospective customers and search engines. Lead with the value proposition. Use scannable structure: short paragraphs, bulleted lists, descriptive H2/H3 headings that contain natural keywords. Concrete benefits over abstract features ("save 4 hours per week" not "boost productivity"). Active voice. End sections with a clear next step.`
  },
  academic: {
    label: 'audiences.academic.label',
    description: 'audiences.academic.description',
    promptFragment: `Write in formal academic register. Use the third person and passive voice where appropriate. Cite claims, distinguish evidence from interpretation, and acknowledge limitations. Define technical terms on first use. Prefer "the data suggest" over "we found". Maintain neutrality and avoid colloquialism.`
  },
  casual: {
    label: 'audiences.casual.label',
    description: 'audiences.casual.description',
    promptFragment: `Write conversationally, like a knowledgeable friend explaining something over coffee. Use contractions, second-person ("you"), and concrete examples. Vary sentence length. Light humor is fine; corporate jargon is not. Aim for an 8th-grade reading level without being condescending.`
  },
  business: {
    label: 'audiences.business.label',
    description: 'audiences.business.description',
    promptFragment: `Write for time-pressed business readers. Open with the bottom line: what, why, what's needed. Use BLUF structure. Quantify wherever possible — numbers, percentages, dates. Bullet lists for parallel items. Avoid technical jargon unless the audience is technical-business. Action items belong at the end of each section.`
  },
  creative: {
    label: 'audiences.creative.label',
    description: 'audiences.creative.description',
    promptFragment: `Write with literary care. Show, don't tell. Vary sentence rhythm. Sensory detail over abstract description. Strong verbs over modified weak ones. Trust the reader. Avoid AI tells: no "in conclusion", no triple-adjective stacks, no symmetrical paragraph endings.`
  }
} as const

export type AudienceKind = keyof typeof AUDIENCES

export const AUDIENCE_KINDS = Object.keys(AUDIENCES) as AudienceKind[]

export function isAudienceKind(value: unknown): value is AudienceKind {
  return typeof value === 'string' && value in AUDIENCES
}
