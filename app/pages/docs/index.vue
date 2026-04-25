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

const { data: navigation } = await useAsyncData('docs:nav', () =>
  queryCollectionNavigation('docs', ['order', 'navHidden'])
)

useSeoMeta({
  title: 'Documentation — YPad',
  description: 'Guides, walkthroughs, and reference for the YPad collaborative markdown editor.'
})

// Hand-curated categories with icon + tagline. Maps to top-level
// folders under content/docs/. Edit here when adding a new section.
const categories = [
  {
    title: 'Getting Started',
    path: '/docs/getting-started',
    icon: 'i-lucide-rocket',
    tagline: 'Your first ten minutes — create a doc, name it, share it.'
  },
  {
    title: 'Writing',
    path: '/docs/writing',
    icon: 'i-lucide-pen-line',
    tagline: 'Markdown extensions, formatting, alerts, math, diagrams, tables.'
  },
  {
    title: 'Sharing & Permissions',
    path: '/docs/sharing',
    icon: 'i-lucide-share-2',
    tagline: 'Access modes, password protection, anonymous links, workspaces.'
  },
  {
    title: 'Themes',
    path: '/docs/themes',
    icon: 'i-lucide-palette',
    tagline: 'Per-document themes that drive both live preview and PDF export.'
  },
  {
    title: 'Import & Export',
    path: '/docs/import-export',
    icon: 'i-lucide-arrow-right-left',
    tagline: 'Bring DOCX/PDF/PPTX in; export to clean Markdown or themed PDF.'
  }
]
</script>

<template>
  <div class="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-8">
    <aside class="hidden md:block">
      <DocsSidebar :nav="navigation ?? []" />
    </aside>

    <main class="max-w-4xl">
      <header class="mb-10">
        <h1 class="text-4xl font-bold tracking-tight mb-3">
          Documentation
        </h1>
        <p class="text-lg text-toned">
          Guides and walkthroughs for the YPad collaborative markdown editor.
          Every screenshot is captured live from the running app — they always
          reflect the current UI.
        </p>
      </header>

      <!-- ─── Categories ─────────────────────────────────────────────
           Top-level entry points. Cards link straight into each
           section's index page. Tightly grid-laid so the page works
           as a sitemap at-a-glance. -->
      <section class="mb-12">
        <h2 class="text-xl font-semibold mb-4">
          By topic
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NuxtLink
            v-for="cat in categories"
            :key="cat.path"
            :to="cat.path"
            class="group p-4 rounded-lg border border-default bg-elevated/50 hover:bg-elevated hover:border-primary/50 transition-colors"
          >
            <div class="flex items-start gap-3">
              <UIcon
                :name="cat.icon"
                class="size-5 text-primary mt-0.5 shrink-0"
              />
              <div class="min-w-0">
                <div class="font-semibold mb-0.5 group-hover:text-primary transition-colors">
                  {{ cat.title }}
                </div>
                <p class="text-sm text-toned">
                  {{ cat.tagline }}
                </p>
              </div>
            </div>
          </NuxtLink>
        </div>
      </section>

      <!-- ─── Featured pages ─────────────────────────────────────────
           Flagged in frontmatter (featured: true). Renders as a
           narrow row of pages worth promoting — "if you only read
           one thing, read these". -->
      <section v-if="featured?.length">
        <h2 class="text-xl font-semibold mb-4">
          Start here
        </h2>
        <ul class="space-y-2">
          <li
            v-for="p in featured"
            :key="p.path"
          >
            <NuxtLink
              :to="p.path"
              class="flex items-baseline gap-3 p-3 rounded-lg border border-default hover:bg-elevated hover:border-primary/50 transition-colors"
            >
              <UIcon
                name="i-lucide-arrow-right"
                class="size-4 text-primary shrink-0 self-center"
              />
              <div class="min-w-0">
                <div class="font-medium">
                  {{ p.title }}
                </div>
                <p
                  v-if="p.description"
                  class="text-sm text-toned"
                >
                  {{ p.description }}
                </p>
              </div>
            </NuxtLink>
          </li>
        </ul>
      </section>
    </main>
  </div>
</template>
