<script setup lang="ts">
// Catch-all docs page. Fetches the matching collection entry +
// surrounding pages (prev/next) for the bottom pager.
//
// Layout: shared docs shell. Article grid: narrow center column for
// prose, opt-in full-bleed for elements with the `docs-wide` class
// (Flow component uses it). Right rail (lg+): on-page TOC sticky.
//
// Index-page handling: Nuxt Content's path normalization for
// folder/index.md is inconsistent across versions. Try both the
// route path AND `<route>/index` so /docs/getting-started resolves
// when the file is content/docs/getting-started/index.md.

import { docsBreadcrumbs } from '~~/shared/seo/breadcrumbs'
import { docsRedirectTarget } from '~~/shared/docs/docsRedirects'

definePageMeta({ layout: 'docs' })

const route = useRoute()
const { t } = useAreaI18n()

const { data: page } = await useAsyncData(`docs:${route.path}`, async () => {
  const direct = await queryCollection('docs').path(route.path).first()
  if (direct) return direct
  return await queryCollection('docs').path(`${route.path}/index`).first()
})

if (!page.value) {
  // An address from before the docs were regrouped: the server answers
  // those with a 301 (route rules in nuxt.config.ts); this covers in-app
  // navigation, which never reaches the server.
  const moved = docsRedirectTarget(route.path)
  if (moved) {
    await navigateTo({ path: moved, query: route.query, hash: route.hash }, { redirectCode: 301, replace: true })
  }
  throw createError({ statusCode: 404, statusMessage: 'Doc not found' })
}

// Surrounding pages for the bottom pager. Returns [prev, next],
// either may be null at the boundaries.
const { data: surround } = await useAsyncData(`docs:surround:${route.path}`, () =>
  queryCollectionItemSurroundings('docs', route.path, {
    fields: ['title', 'description']
  })
)

const docPage = page.value
const { imageUrl } = useMarketingSeo({
  title: docPage.title,
  description: docPage.description ?? '',
  imageGroup: 'docs',
  type: 'article',
  modifiedTime: docPage.updated
})
// TechArticle + BreadcrumbList (marketing site only; elsewhere the
// canonical points at markoto.app, which carries them).
usePageStructuredData(() => ({
  name: docPage.title,
  description: docPage.description ?? '',
  dateModified: docPage.updated,
  image: imageUrl.value,
  article: 'TechArticle',
  breadcrumbs: docsBreadcrumbs(route.path, docPage.title),
  about: [{ self: true }]
}))

// Visible breadcrumb: Docs › <section title> › <page title>, the same
// trail as the BreadcrumbList JSON-LD without its Home crumb. The last
// crumb is the current page, non-clickable.
const crumbs = computed(() =>
  docsBreadcrumbs(route.path, docPage.title).slice(1).map((crumb, i, all) => ({
    label: i === 0 ? t('common.docs') : crumb.name,
    to: i === all.length - 1 ? '' : crumb.path
  }))
)

// Hide the on-page TOC on pages with fewer than 2 headings, it'd
// just show the title and look thin.
const hasToc = computed(() => (page.value?.body?.toc?.links?.length ?? 0) >= 2)
</script>

<template>
  <div
    v-if="page"
    class="grid lg:grid-cols-[1fr_220px] lg:gap-8 px-4 sm:px-6 md:px-12 py-8 sm:py-16"
  >
    <article class="min-w-0 prose dark:prose-invert max-w-none">
      <!-- Breadcrumb sits at the very top of the article column.
           A generous gap below it (`mb-10`) lets the page title
           breathe: the previous `mb-4` had crumbs and h1 nearly
           touching, which read as cramped chrome stacked on chrome. -->
      <UBreadcrumb
        :items="crumbs"
        class="not-prose mb-6 sm:mb-10 font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted"
      />
      <ContentRenderer
        :value="page"
        class="docs-content"
      />

      <!-- Bottom pager: clickable cards for prev / next. Stripe / Vue
           docs convention. Uses fields fetched via
           queryCollectionItemSurroundings. -->
      <!-- Prev / next pager. Editorial register: JetBrains Mono mini-
           label ("previous" / "next") with the value below in Fraunces.
           Hover swap stays sumi (was shu, shu means AI presence). -->
      <nav
        v-if="surround && (surround[0] || surround[1])"
        class="not-prose mt-8 sm:mt-12 pt-6 sm:pt-8 border-t border-default/60 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4"
        :aria-label="t('docs.pagination.label')"
      >
        <NuxtLink
          v-if="surround[0]"
          :to="surround[0].path"
          class="group block p-4 rounded-lg border border-default/60 bg-default hover:border-default hover:bg-default/80 transition-colors"
        >
          <div class="flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted mb-1.5">
            <UIcon
              name="i-lucide-arrow-left"
              class="size-3"
            />
            {{ t('docs.pagination.previous') }}
          </div>
          <div class="font-serif text-base font-normal tracking-tight text-default">
            {{ surround[0].title }}
          </div>
          <div
            v-if="surround[0].description"
            class="mt-1 text-sm text-muted line-clamp-2"
          >
            {{ surround[0].description }}
          </div>
        </NuxtLink>
        <div v-else />
        <NuxtLink
          v-if="surround[1]"
          :to="surround[1].path"
          class="group block p-4 rounded-lg border border-default/60 bg-default hover:border-default hover:bg-default/80 transition-colors sm:text-right"
        >
          <div class="flex items-center gap-1.5 sm:justify-end font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted mb-1.5">
            {{ t('docs.pagination.next') }}
            <UIcon
              name="i-lucide-arrow-right"
              class="size-3"
            />
          </div>
          <div class="font-serif text-base font-normal tracking-tight text-default">
            {{ surround[1].title }}
          </div>
          <div
            v-if="surround[1].description"
            class="mt-1 text-sm text-muted line-clamp-2"
          >
            {{ surround[1].description }}
          </div>
        </NuxtLink>
      </nav>
    </article>

    <!-- On-page TOC. Right rail on lg+, hidden below, narrower
         viewports collapse the TOC into the article body would push
         long pages too far down; readers can use the breadcrumb +
         scroll instead. Auto-hidden on pages with <2 headings. -->
    <aside
      v-if="hasToc"
      class="hidden lg:block min-w-0"
    >
      <div class="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto overflow-x-hidden break-words">
        <UContentToc
          :title="t('docs.onThisPage')"
          :links="page.body.toc?.links ?? []"
          highlight
          class="text-sm"
        />
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* Prose article uses Nuxt UI's `prose` defaults; .docs-content drives
   the opt-in full-bleed for elements like `<Flow>` so screenshots
   span the full main column without disturbing prose width. */
.docs-content {
  display: grid;
  grid-template-columns:
    minmax(0, 1fr)
    min(72ch, 100%)
    minmax(0, 1fr);
  column-gap: 0;
}
.docs-content :deep(> *) {
  grid-column: 2;
}
.docs-content :deep(> .docs-wide) {
  grid-column: 1 / -1;
  max-width: 1100px;
  justify-self: center;
  width: 100%;
}
/* Inline code is `inline-block` (Nuxt UI prose): a long token (a URL,
   a config key) can't wrap and pushed the page wider than a phone. */
.docs-content :deep(:not(pre) > code) {
  max-width: 100%;
  overflow-wrap: anywhere;
}
</style>
