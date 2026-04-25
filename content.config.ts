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
    })
  }
})
