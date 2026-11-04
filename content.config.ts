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
        navHidden: z.boolean().optional()
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
        // Site-relative 1200×630 PNG/JPEG for link previews; default card otherwise.
        ogImage: z.string().optional(),
        // Search terms the page is written for (editorial; not emitted as a meta tag).
        keywords: z.array(z.string()).optional(),
        // Last substantive edit, YYYY-MM-DD (shown on the page).
        updated: z.string().optional(),
        // false = translation not yet read by a native speaker: noindex,
        // no hreflang, not in the sitemap. Absent = reviewed.
        reviewed: z.boolean().default(true),
        // Header/footer menu the page is listed in, with its short label.
        navGroup: z.enum(['use-cases', 'compare']).optional(),
        navLabel: z.string().optional(),
        navOrder: z.number().optional()
      })
    })
  }
})
