<script setup lang="ts">
// /docs landing page. Hand-written (not driven by a markdown file)
// because it's mostly UI affordances — category cards + featured-flow
// shortcuts — rather than prose. The catch-all [...slug].vue handles
// every OTHER /docs/* path.
//
// Featured cards: pulled live from the docs collection where
// `featured: true` in frontmatter. Categories: hardcoded list with
// curated copy (more polished than auto-derived from folder names).

const { data: featured } = await useAsyncData('docs:featured', () =>
  queryCollection('docs')
    .where('featured', '=', true)
    .order('order', 'ASC')
    .all()
)

useSeoMeta({
  title: 'Documentation — YPad',
  description: 'Guides, walkthroughs, and reference for the YPad collaborative markdown editor.'
})

definePageMeta({ layout: 'docs' })

// Categories are derived live from each section's index.md so the
// landing-page card titles + icons stay in lockstep with the
// sidebar / per-page metadata. We list folders explicitly to keep
// ordering predictable; one query per folder.
const sectionPaths = [
  { path: '/docs/getting-started', tagline: 'Your first ten minutes — create a doc, name it, share it.' },
  { path: '/docs/writing', tagline: 'Markdown extensions, formatting, alerts, math, diagrams, tables.' },
  { path: '/docs/sharing', tagline: 'Access modes, password protection, anonymous links, workspaces.' },
  { path: '/docs/themes', tagline: 'Per-document themes that drive both live preview and PDF export.' },
  { path: '/docs/import-export', tagline: 'Bring DOCX/PDF/PPTX in; export to clean Markdown or themed PDF.' }
]

// Each section's index.md is stored at the bare folder path. Try
// that first; fall back to `${path}/index` for any environment where
// Nuxt Content normalizes index pages differently.
const { data: sections } = await useAsyncData('docs:sections', async () => {
  const out = []
  for (const s of sectionPaths) {
    const page = (await queryCollection('docs').path(s.path).first())
      ?? (await queryCollection('docs').path(`${s.path}/index`).first())
    if (page) out.push({ ...s, title: page.title, icon: page.icon ?? 'i-lucide-folder' })
  }
  return out
})

// Direct handle on the search modal's open state. Toggling this is
// equivalent to pressing Cmd-K — opens the same UContentSearch modal
// mounted at the layout level. Cleaner than dispatching a synthetic
// keyboard event (which @nuxt/ui's defineShortcuts may filter as
// untrusted).
const { open: openSearch } = useContentSearch()
</script>

<template>
  <div class="max-w-5xl mx-auto px-6 md:px-12 py-16 md:py-20">
    <!-- Hero. Centered, generous whitespace. The decorative gradient
         softens the otherwise-stark page header on a docs landing
         that's mostly cards underneath. CTA buttons set expectations
         for the two main reader paths: structured tutorial vs free
         search. -->
    <header class="text-center mb-16">
      <div class="inline-flex items-center gap-2 mb-5 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium uppercase tracking-wider">
        <UIcon name="i-lucide-book-open" class="size-3.5" />
        Documentation
      </div>
      <h1 class="text-4xl md:text-5xl font-bold tracking-tight mb-5 text-default">
        Everything you can do in YPad
      </h1>
      <p class="text-lg text-toned leading-relaxed max-w-2xl mx-auto">
        A collaborative markdown editor with optional accounts. Write
        anonymously, share by URL, theme it, export to PDF — these
        guides walk through it. Every screenshot is captured live from
        the running app.
      </p>
      <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
        <UButton
          to="/docs/getting-started/quick-share"
          icon="i-lucide-rocket"
          color="primary"
          size="md"
          trailing-icon="i-lucide-arrow-right"
        >
          Start the first walkthrough
        </UButton>
        <UButton
          color="neutral"
          variant="subtle"
          size="md"
          icon="i-lucide-search"
          @click="openSearch = true"
        >
          Search
          <kbd class="ml-1 px-1.5 py-0.5 rounded border border-default bg-default/50 text-xs font-mono">⌘K</kbd>
        </UButton>
      </div>
    </header>

    <!-- Featured pages — "Start here" — promoted to a denser two-up
         grid right under the hero. Newcomer's first action surface. -->
    <section v-if="featured?.length" class="mb-16">
      <div class="flex items-baseline justify-between gap-4 mb-5">
        <h2 class="text-2xl font-semibold tracking-tight">
          Start here
        </h2>
        <span class="text-xs uppercase tracking-wider text-muted">
          Most-load-bearing flows
        </span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NuxtLink
          v-for="p in featured"
          :key="p.path"
          :to="p.path"
          class="group relative p-6 rounded-xl border border-default/60 hover:border-primary/40 hover:bg-elevated/40 hover:shadow-sm transition-all"
        >
          <div class="flex items-start gap-4">
            <div class="shrink-0 size-10 rounded-lg flex items-center justify-center text-muted group-hover:bg-primary/10 group-hover:text-primary transition-colors">
              <UIcon name="i-lucide-arrow-right" class="size-5" />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="font-semibold text-base mb-1 group-hover:text-primary transition-colors">
                {{ p.title }}
              </h3>
              <p v-if="p.description" class="text-sm text-toned leading-relaxed">
                {{ p.description }}
              </p>
            </div>
          </div>
        </NuxtLink>
      </div>
    </section>

    <!-- Sections — every top-level folder. Title + icon driven by
         each folder's index.md frontmatter. Three across on desktop
         keeps the page from feeling tall + lets the eye scan. -->
    <section>
      <div class="flex items-baseline justify-between gap-4 mb-5">
        <h2 class="text-2xl font-semibold tracking-tight">
          Browse by topic
        </h2>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <NuxtLink
          v-for="cat in sections ?? []"
          :key="cat.path"
          :to="cat.path"
          class="group p-5 rounded-xl border border-default/60 hover:border-primary/40 hover:bg-elevated/40 hover:shadow-sm transition-all"
        >
          <div class="size-10 rounded-lg flex items-center justify-center mb-3 text-muted group-hover:bg-primary/10 group-hover:text-primary transition-colors">
            <UIcon :name="cat.icon" class="size-5" />
          </div>
          <h3 class="font-semibold mb-1 group-hover:text-primary transition-colors">
            {{ cat.title }}
          </h3>
          <p class="text-sm text-toned leading-relaxed">
            {{ cat.tagline }}
          </p>
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
