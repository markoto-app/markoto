import { defineContentConfig, defineCollection, z } from '@nuxt/content'

// Nuxt Content v3 config. The `docs` collection sources from
// content/docs/**/*.md so any markdown file under that tree becomes a
// route at /docs/<...slug>. Pages are rendered by app/pages/docs/[...slug].vue
// using <ContentRenderer>.
//
// Flow assets (PNGs + manifest.json) live in public/flows/ — they're NOT
// part of any content collection. The <Flow> component fetches them via
// $fetch directly. Keeps the build fast: regenerating screenshots
// doesn't trigger a content rebuild.

// One cell of a comparison table: `true` / `false` / `partial` or a short
// text, where it comes from (a URL for competitors; a docs page or repo
// path for markoto) and when it was last checked (YYYY-MM-DD).
const compareClaim = z.object({
  value: z.union([z.boolean(), z.string()]),
  source: z.string(),
  checked: z.string()
})

export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: 'page',
      source: { include: 'docs/**/*.md' },
      schema: z.object({
        title: z.string(),
        description: z.string().optional(),
        // Manual sidebar ordering. Lower numbers sort first within a
        // folder; pages without a number sort by title at the end of
        // their group. Folders themselves are ordered by their index
        // page's `order` value.
        order: z.number().optional(),
        // Lucide icon name. Sections (folder index pages) use this for
        // the sidebar group header + the landing-page category card.
        // Leaf pages can omit and inherit visual weight from their parent.
        icon: z.string().optional(),
        // Optional category override. Defaults to the parent folder
        // name (e.g. "writing/tables.md" → category "writing"). Set
        // explicitly only when grouping needs to deviate from the
        // directory layout — e.g. cross-cutting "advanced" pages
        // pulled out of their nominal folders for the landing page.
        category: z.string().optional(),
        // If true, this page is shown as a featured card on the
        // /docs landing page. Use sparingly — only the 3-5 most
        // load-bearing entry points belong here.
        featured: z.boolean().optional(),
        // Auto-generated nav (queryCollectionNavigation) doesn't filter
        // out section indexes. `navHidden: true` keeps a page reachable
        // by URL but skips it in the sidebar — useful for landing /
        // index pages that are the parent group's clickable header.
        navHidden: z.boolean().optional(),
        // Last substantive edit, YYYY-MM-DD: TechArticle dateModified,
        // article:modified_time and the sitemap's <lastmod>. Bump it when
        // the page's content changes (not for typo fixes).
        updated: z.string().optional()
      })
    }),
    // Public marketing pages of the hosted site (use cases, cheat sheet,
    // later comparisons). One file per language:
    // content/marketing/<locale>/<slug>.md → `/<slug>` (en) or
    // `/<locale>/<slug>` (de, fr). Rendered by app/pages/[...marketing].vue,
    // route + language rules in shared/seo/marketing.ts.
    marketing: defineCollection({
      type: 'page',
      source: { include: 'marketing/**/*.md' },
      schema: z.object({
        // Search-result title WITHOUT the " · markoto" suffix (≤ 60 with it).
        title: z.string(),
        // Meta description, ≤ 160 characters.
        description: z.string(),
        // Site-relative 1200×630 PNG/JPEG for link previews; the group's card
        // otherwise (shared/seo/ogImages.ts: use cases / compare).
        ogImage: z.string().optional(),
        // Alt text of `ogImage` (required in practice when ogImage is set).
        ogImageAlt: z.string().optional(),
        // Step-by-step instructions on the page → HowTo JSON-LD. Only for
        // pages that really are a how-to; the steps must match the page text.
        howTo: z.object({
          name: z.string(),
          steps: z.array(z.object({ name: z.string(), text: z.string() }))
        }).optional(),
        // Search terms the page is written for (editorial; not emitted as a meta tag).
        keywords: z.array(z.string()).optional(),
        // Last substantive edit, YYYY-MM-DD (shown on the page; also
        // dateModified, article:modified_time and the sitemap's <lastmod>).
        updated: z.string().optional(),
        // false = translation not yet read by a native speaker: noindex,
        // no hreflang, not in the sitemap. Absent = reviewed.
        reviewed: z.boolean().default(true),
        // Header/footer menu the page is listed in, with its short label.
        navGroup: z.enum(['use-cases', 'compare']).optional(),
        navLabel: z.string().optional(),
        navOrder: z.number().optional()
      })
    }),
    // Claim data of the comparison pages (/compare/<slug>), one file per
    // competitor: content/compare/<slug>.yml. Every value carries its
    // source and the day it was checked; tests/unit/compareClaims.test.ts
    // fails once a check is older than nine months. Rendered by
    // `::compare-facts{competitor}` + `::compare-sources{competitor}`
    // (app/components/content/CompareFacts.vue, CompareSources.vue).
    compare: defineCollection({
      type: 'data',
      source: 'compare/*.yml',
      schema: z.object({
        // Display name of the competitor, as it writes it.
        name: z.string(),
        rows: z.array(z.object({
          feature: z.string(),
          note: z.string().optional(),
          markoto: compareClaim,
          competitor: compareClaim
        }))
      })
    })
  }
})
