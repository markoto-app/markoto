<script setup lang="ts">
import { docsBreadcrumbs } from '~~/shared/seo/breadcrumbs'
import { DOCS_SECTIONS } from '~~/shared/docs/docsSections'

// /docs landing page. Hand-written (not driven by a markdown file)
// because it's mostly UI affordances, category cards + featured-flow
// shortcuts: rather than prose. The catch-all [...slug].vue handles
// every OTHER /docs/* path.
//
// Featured cards: pulled live from the docs collection where
// `featured: true` in frontmatter. Sections: every folder of
// shared/docs/docsSections.ts, with the title, icon and description of
// its index.md.

// English like the docs themselves (app/composables/platform/useAreaI18n.ts).
const { t, locale: areaLocale } = useAreaI18n()

const { data: featured } = await useAsyncData('docs:featured', () =>
  queryCollection('docs')
    .where('featured', '=', true)
    .order('order', 'ASC')
    .all()
)

const metaTitle = t('docs.landing.metaTitle')
const metaDescription = t('docs.landing.metaDescription')
const { imageUrl } = useMarketingSeo({
  title: metaTitle,
  description: metaDescription,
  imageGroup: 'docs'
})
usePageStructuredData(() => ({
  pageType: 'CollectionPage',
  name: metaTitle,
  description: metaDescription,
  image: imageUrl.value,
  breadcrumbs: docsBreadcrumbs('/docs', metaTitle),
  about: [{ self: true }]
}))

definePageMeta({ layout: 'docs' })

// Sections are derived live from each section's index.md so the
// landing-page cards stay in lockstep with the sidebar: same order
// (DOCS_SECTIONS), same title and icon, the index page's description as
// the card text. Each section's index.md is stored at the bare folder
// path; `${path}/index` is the fallback for any environment where Nuxt
// Content normalizes index pages differently.
const { data: sections } = await useAsyncData('docs:sections', async () => {
  const out = []
  for (const slug of DOCS_SECTIONS) {
    const path = `/docs/${slug}`
    const page = (await queryCollection('docs').path(path).first())
      ?? (await queryCollection('docs').path(`${path}/index`).first())
    if (page) out.push({ path, title: page.title, description: page.description ?? '', icon: page.icon ?? 'i-lucide-folder' })
  }
  return out
})

// Direct handle on the search modal's open state. Toggling this is
// equivalent to pressing Cmd-K, opens the same UContentSearch modal
// mounted at the layout level. Cleaner than dispatching a synthetic
// keyboard event (which @nuxt/ui's defineShortcuts may filter as
// untrusted).
const { open: openSearch } = useContentSearch()
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 md:px-12 py-8 sm:py-16 md:py-20">
    <!-- Hero. Centered, generous whitespace. The decorative gradient
         softens the otherwise-stark page header on a docs landing
         that's mostly cards underneath. CTA buttons set expectations
         for the two main reader paths: structured tutorial vs free
         search. -->
    <!-- Hero in the editorial register. Mono eyebrow with a 22px
         hairline rule (same pattern the homepage mockup uses), a
         Fraunces 300/italic-emphasis display headline, a tight Inter
         lede capped at 34ch, and an underline-mono CTA pair. The
         previous version wore a lucide book + capitalized eyebrow
         pill which read as "developer tool docs", not "studio
         field guide". -->
    <header class="mb-10 sm:mb-20 max-w-2xl">
      <div class="flex items-center gap-2.5 mb-4 sm:mb-6 text-muted font-mono text-[11px] tracking-[0.06em] uppercase">
        <span class="block w-[22px] h-px bg-current opacity-60" />
        <span>{{ t('docs.landing.eyebrow') }}</span>
      </div>
      <h1 class="font-serif text-[34px] sm:text-5xl md:text-6xl font-light tracking-tight leading-[1.06] sm:leading-[1.04] mb-4 sm:mb-6 text-default">
        <i18n-t
          keypath="docs.landing.title"
          scope="global"
          :locale="areaLocale"
        >
          <template #product>
            <em class="italic font-normal">markoto</em>
          </template>
        </i18n-t>
      </h1>
      <p class="text-[14px] leading-[1.65] text-muted max-w-[34ch]">
        {{ t('docs.landing.lede') }}
      </p>
      <div class="mt-8 flex flex-wrap items-center gap-6">
        <NuxtLink
          to="/docs/getting-started/quick-share"
          class="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.06em] uppercase text-default border-b border-default pb-0.5 hover:text-muted hover:border-default/60 transition-colors"
        >
          <span>{{ t('docs.landing.begin') }}</span>
          <span aria-hidden="true">→</span>
        </NuxtLink>
        <button
          type="button"
          class="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.06em] uppercase text-muted hover:text-default transition-colors"
          @click="openSearch = true"
        >
          <UIcon
            name="i-lucide-search"
            class="size-3.5"
          />
          <span>{{ t('docs.landing.search') }}</span>
          <kbd class="ml-1 px-1.5 py-0.5 rounded border border-default/70 bg-default text-[10px] font-mono tracking-normal text-default normal-case">⌘K</kbd>
        </button>
      </div>
    </header>

    <!-- Featured pages, "Start here", promoted to a denser two-up
         grid right under the hero. Newcomer's first action surface. -->
    <!-- "Start here": the entry-point flows. Cards drop the shu
         hover (was `border-primary/40` + `bg-primary/10` arrow puck);
         shu stays AI-only. Hover is now a calm sumi border + bone fill
         lift. Section eyebrow uses the JetBrains Mono 0.06em register
         that runs through the whole product. -->
    <section
      v-if="featured?.length"
      class="mb-10 sm:mb-16"
    >
      <div class="flex items-baseline justify-between gap-4 mb-5 flex-wrap">
        <h2 class="font-serif text-2xl sm:text-3xl font-normal tracking-tight">
          {{ t('docs.landing.startHere') }}
        </h2>
        <span class="hidden sm:inline font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted">
          {{ t('docs.landing.startHereHint') }}
        </span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NuxtLink
          v-for="p in featured"
          :key="p.path"
          :to="p.path"
          class="group relative p-4 sm:p-6 rounded-xl border border-default/60 bg-default hover:border-default hover:bg-default/80 transition-colors"
        >
          <div class="flex items-start gap-4">
            <div class="shrink-0 size-10 rounded-lg flex items-center justify-center bg-muted text-toned group-hover:text-default transition-colors">
              <UIcon
                name="i-lucide-arrow-right"
                class="size-5"
              />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="font-serif text-lg font-normal mb-1">
                {{ p.title }}
              </h3>
              <p
                v-if="p.description"
                class="text-sm text-muted leading-relaxed"
              >
                {{ p.description }}
              </p>
            </div>
          </div>
        </NuxtLink>
      </div>
    </section>

    <!-- Sections: every top-level folder. Title + icon driven by
         each folder's index.md frontmatter. Three across on desktop
         keeps the page from feeling tall + lets the eye scan. -->
    <section>
      <div class="flex items-baseline justify-between gap-4 mb-5">
        <h2 class="font-serif text-2xl sm:text-3xl font-normal tracking-tight">
          {{ t('docs.landing.browse') }}
        </h2>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <NuxtLink
          v-for="cat in sections ?? []"
          :key="cat.path"
          :to="cat.path"
          class="group p-4 sm:p-5 rounded-xl border border-default/60 bg-default hover:border-default hover:bg-default/80 transition-colors"
        >
          <div class="size-10 rounded-lg flex items-center justify-center mb-3 bg-muted text-toned group-hover:text-default transition-colors">
            <UIcon
              :name="cat.icon"
              class="size-5"
            />
          </div>
          <h3 class="font-serif text-lg font-normal mb-1">
            {{ cat.title }}
          </h3>
          <p
            v-if="cat.description"
            class="text-sm text-muted leading-relaxed"
          >
            {{ cat.description }}
          </p>
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
