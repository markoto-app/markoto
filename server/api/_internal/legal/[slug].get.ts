import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { legalMarkdown } from '~~/server/utils/privacy/legalMarkdown'
import { resolveLegalEntity } from '~~/shared/legal/entity'
import { legalDocumentParams, legalDocumentQuery } from '~~/shared/api/platform'
import { renderProcessingPurposesMarkdown } from '~~/server/legal/registryView'
import { isBillingEnabled } from '~~/server/utils/billing/billingMode'
import {
  ABUSE_POLICY_EFFECTIVE_DATE,
  ABUSE_POLICY_VERSION,
  AUTHORITATIVE_LOCALE,
  DPA_EFFECTIVE_DATE,
  DPA_VERSION,
  IMPRINT_EFFECTIVE_DATE,
  IMPRINT_VERSION,
  LEGAL_DOCUMENT_LOCALES,
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_VERSION,
  TOS_EFFECTIVE_DATE,
  PAID_TERMS_EFFECTIVE_DATE,
  PAID_TERMS_VERSION,
  TOS_VERSION
} from '~~/shared/legal/versions'

// GET /api/_internal/legal/<slug>?locale=<bcp47>: renders
// `content/legal/<slug>/<locale>.md` (frontmatter stripped, template variables
// filled from `shared/legal/{versions,entity}.ts`) to HTML.
//
// Slug allowlist: only the maintained legal documents; the endpoint must not
// become a generic markdown renderer.
// Locale fallback: requested locale, then authoritative English, else 500.
// markdown-it runs with `html: false` so the source can't smuggle raw HTML.

const ALLOWED_SLUGS = ['privacy', 'terms', 'paid-terms', 'dpa', 'abuse-policy', 'imprint'] as const
type LegalSlug = (typeof ALLOWED_SLUGS)[number]

interface SlugMetadata {
  version: number
  effectiveDate: string
  // Kept here, not in the frontmatter, to avoid parsing YAML twice.
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
  'paid-terms': {
    version: PAID_TERMS_VERSION,
    effectiveDate: PAID_TERMS_EFFECTIVE_DATE,
    defaultTitle: 'Paid Plans Terms'
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
  },
  'imprint': {
    version: IMPRINT_VERSION,
    effectiveDate: IMPRINT_EFFECTIVE_DATE,
    defaultTitle: 'Imprint'
  }
}

export default defineApiHandler({
  access: allow.public('Legal documents must be readable without an account; slug allowlist and locale guard are in the handler'),
  // The bundled texts describe the hosted markoto.app service; a
  // deployment with the legal surfaces off (self-hosted default) must not
  // serve them under its own origin. See shared/config/instance.ts.
  instance: 'legalSurfaces',
  params: legalDocumentParams,
  query: legalDocumentQuery,
  handler: async ({ params, query }) => {
    const slugParam = params.slug
    if (!slugParam || !ALLOWED_SLUGS.includes(slugParam as LegalSlug)) {
      throw apiError('resource/not-found')
    }
    const slug = slugParam as LegalSlug

    const requestedLocale = query.locale ?? AUTHORITATIVE_LOCALE
    // Unsupported locales fall back to English without a 404.
    const locale = LEGAL_DOCUMENT_LOCALES.includes(
      requestedLocale as (typeof LEGAL_DOCUMENT_LOCALES)[number]
    )
      ? requestedLocale
      : AUTHORITATIVE_LOCALE

    const meta = SLUG_META[slug]
    const entity = resolveLegalEntity()

    // Falls back to English on miss; a missing English copy breaks the invariant
    // that every document has an English source, so it is a 500.
    const baseDir = join(process.cwd(), 'content', 'legal', slug)
    let chosenLocale = locale
    let raw: string
    try {
      raw = await readFile(join(baseDir, `${chosenLocale}.md`), 'utf8')
    } catch {
      if (chosenLocale === AUTHORITATIVE_LOCALE) {
        throw apiError('internal')
      }
      chosenLocale = AUTHORITATIVE_LOCALE
      try {
        raw = await readFile(join(baseDir, `${chosenLocale}.md`), 'utf8')
      } catch {
        throw apiError('internal')
      }
    }

    // Versions and effective dates come from the TypeScript registry, so no
    // frontmatter values are needed.
    const body = stripFrontmatter(raw)

    const substitutions: Record<string, string> = {
      currentVersion: String(meta.version),
      effectiveDate: meta.effectiveDate,
      controllerName: entity.controllerName,
      controllerAddress: entity.controllerAddress,
      privacyContactEmail: entity.privacyContactEmail,
      abuseContactEmail: entity.abuseContactEmail,
      governingLaw: entity.governingLaw,
      legalForm: entity.legalForm,
      registeredOffice: entity.registeredOffice,
      representedBy: entity.representedBy,
      uid: entity.uid,
      chId: entity.chId,
      ehraId: entity.ehraId,
      processingPurposesTable: renderProcessingPurposesMarkdown(isBillingEnabled())
    }
    const substituted = body.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
      if (!Object.hasOwn(substitutions, key)) return full
      return substitutions[key] ?? full
    })

    const html = legalMarkdown.render(substituted)

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
  }
})

function stripFrontmatter(raw: string): string {
  // Match a leading `---\n...\n---\n?` block. If the file has no
  // frontmatter we return it unchanged.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  return match ? raw.slice(match[0].length) : raw
}
