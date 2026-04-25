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
        // Manual sidebar ordering. Lower numbers sort first; pages without
        // a number sort by title at the end of their group.
        order: z.number().optional()
      })
    })
  }
})
