import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import MarkdownIt from 'markdown-it'
import { resolveLegalEntity } from '~~/shared/legal/entity'
import {
  ABUSE_POLICY_EFFECTIVE_DATE,
  ABUSE_POLICY_VERSION,
  AUTHORITATIVE_LOCALE,
  DPA_EFFECTIVE_DATE,
  DPA_VERSION,
  LEGAL_DOCUMENT_LOCALES,
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_VERSION,
  TOS_EFFECTIVE_DATE,
  TOS_VERSION
} from '~~/shared/legal/versions'

// Renderer for our four customer-facing legal documents.
//
//   GET /api/_internal/legal/<slug>?locale=<bcp47>
//
// Reads `content/legal/<slug>/<locale>.md`, falls back to the
// authoritative-English source when the locale isn't translated yet,
// strips the markdown frontmatter, substitutes template variables
// (`{{currentVersion}}` / `{{effectiveDate}}` / `{{controllerName}}`
// / etc.) from `shared/legal/{versions,entity}.ts`, runs the body
// through markdown-it, and returns the rendered HTML alongside the
// metadata the page chrome needs.
//
// **Slug allowlist** — only the four legal documents we maintain.
// Any other slug returns 404; this prevents the endpoint from being
// repurposed as a generic markdown-renderer for arbitrary content.
//
// **Locale fallback chain** — requested locale → authoritative
// English → 404. We don't go further than English because every
// document MUST exist in English (it's the authoritative version).
//
// **No HTML in source** — markdown-it runs with `html: false`, so
// the markdown source can't smuggle raw HTML through. The HTML
// produced is from markdown structure only (paragraphs, lists,
// links, headings, blockquotes, inline code). The renderer's
// `linkify: true` auto-links bare URLs in the body for convenience.

const ALLOWED_SLUGS = ['privacy', 'terms', 'dpa', 'abuse-policy'] as const
type LegalSlug = (typeof ALLOWED_SLUGS)[number]

interface SlugMetadata {
  version: number
  effectiveDate: string
  // Display title to surface above the rendered body. Lives here
  // (not in the markdown frontmatter) so we don't have to parse
  // YAML twice — the body's `# Title` heading gets rendered as the
  // h1 by markdown-it.
  defaultTitle: string
}

const SLUG_META: Record<LegalSlug, SlugMetadata> = {
  'privacy': {
    version: PRIVACY_VERSION,
    effectiveDate: PRIVACY_EFFECTIVE_DATE,
    defaultTitle: 'Privacy Policy'
  },
  'terms': {
    version: TOS_VERSION,
    effectiveDate: TOS_EFFECTIVE_DATE,
    defaultTitle: 'Terms of Service'
  },
  'dpa': {
    version: DPA_VERSION,
    effectiveDate: DPA_EFFECTIVE_DATE,
    defaultTitle: 'Data Processing Addendum'
  },
  'abuse-policy': {
    version: ABUSE_POLICY_VERSION,
    effectiveDate: ABUSE_POLICY_EFFECTIVE_DATE,
    defaultTitle: 'Abuse and Illegal Content Policy'
  }
}

const md = new MarkdownIt({
  html: false, // markdown source is trusted but defence-in-depth — any future external author can't smuggle raw HTML
  linkify: true, // bare URLs in the body auto-link
  typographer: true
})

export default defineEventHandler(async (event) => {
  const slugParam = getRouterParam(event, 'slug')
  if (!slugParam || !ALLOWED_SLUGS.includes(slugParam as LegalSlug)) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  const slug = slugParam as LegalSlug

  const requestedLocale = (getQuery(event).locale as string | undefined) ?? AUTHORITATIVE_LOCALE
  // Locale must match our allowlist (privacy doc has fr/de/es; the
  // others ship English-only with stubs). Anything else falls back
  // straight to English without a 404.
  const locale = LEGAL_DOCUMENT_LOCALES.includes(
    requestedLocale as (typeof LEGAL_DOCUMENT_LOCALES)[number]
  )
    ? requestedLocale
    : AUTHORITATIVE_LOCALE

  const meta = SLUG_META[slug]
  const entity = resolveLegalEntity()

  // Read the requested-locale file, falling back to English on miss.
  // ENOENT on the English copy is a 404 (shouldn't happen — every
  // document has an English source by invariant — surface as 500).
  const baseDir = join(process.cwd(), 'content', 'legal', slug)
  let chosenLocale = locale
  let raw: string
  try {
    raw = await readFile(join(baseDir, `${chosenLocale}.md`), 'utf8')
  } catch {
    if (chosenLocale === AUTHORITATIVE_LOCALE) {
      // Authoritative copy missing — that's a real bug, not a 404.
      throw createError({ statusCode: 500, message: 'Authoritative legal source missing' })
    }
    chosenLocale = AUTHORITATIVE_LOCALE
    try {
      raw = await readFile(join(baseDir, `${chosenLocale}.md`), 'utf8')
    } catch {
      throw createError({ statusCode: 500, message: 'Authoritative legal source missing' })
    }
  }

  // Strip frontmatter (everything between the first two `---` lines
  // of the file). We don't actually need any frontmatter values at
  // render time — versions + effective dates come from the
  // typescript registry to keep the source-of-truth in one place.
  const body = stripFrontmatter(raw)

  // Substitute template variables. Order doesn't matter — keys
  // don't overlap. Using a single regex pass keeps this O(n).
  const substitutions: Record<string, string> = {
    currentVersion: String(meta.version),
    effectiveDate: meta.effectiveDate,
    controllerName: entity.controllerName,
    controllerAddress: entity.controllerAddress,
    privacyContactEmail: entity.privacyContactEmail,
    abuseContactEmail: entity.abuseContactEmail,
    governingLaw: entity.governingLaw
  }
  const substituted = body.replace(/\{\{(\w+)\}\}/g, (full, key) => {
    return Object.prototype.hasOwnProperty.call(substitutions, key)
      ? substitutions[key]!
      : full
  })

  const html = md.render(substituted)

  return {
    slug,
    title: meta.defaultTitle,
    version: meta.version,
    effectiveDate: meta.effectiveDate,
    requestedLocale: locale,
    actualLocale: chosenLocale,
    isFallback: chosenLocale !== locale,
    authoritativeLocale: AUTHORITATIVE_LOCALE,
    html
  }
})

function stripFrontmatter(raw: string): string {
  // Match a leading `---\n...\n---\n?` block. If the file has no
  // frontmatter we return it unchanged.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  return match ? raw.slice(match[0].length) : raw
}
