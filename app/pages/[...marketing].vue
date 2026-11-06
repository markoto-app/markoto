<script setup lang="ts">
import {
  COMPARE_HUB_CRUMB,
  COMPARE_HUB_SLUG,
  hreflangLinks,
  isIndexableVersion,
  marketingPageKind,
  marketingRoutePath
} from '~~/shared/seo/marketing'
import { hubBreadcrumbs, pageBreadcrumbs } from '~~/shared/seo/breadcrumbs'
import { fetchCompareData, fetchCompareHubItems, fetchMarketingPage } from '~/utils/marketingPage'

// Marketing content pages of the hosted site (content/marketing/<locale>/<slug>.md):
// `/<slug>` in English, `/de/<slug>`, `/fr/<slug>` for translations.
// Route + language rules: shared/seo/marketing.ts. The UI language on
// prefixed routes follows the URL (plugins/marketing-locale.ts).
//
// This catch-all sits below every other page in the router (static and
// dynamic segments win: /d, /w, /docs, /legal, /settings, …; /api and
// other server routes never reach Vue), so it also answers every unknown
// path: 404, exactly as before. Off the marketing site the middleware
// 404s before anything is queried.
definePageMeta({ layout: 'marketing', middleware: 'marketing-pages' })

const route = useRoute()
const { t, locale } = useI18n()
const { siteUrl } = useInstanceConfig()

const { data } = await useAsyncData(`marketing:${route.path}`, () => fetchMarketingPage(route.path))
if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true })
}
const { target, page, versions } = data.value

const indexable = isIndexableVersion(page)
// Comparison hub (`/compare`), comparison pages (`/compare/<slug>`) and
// everything else (use cases, the cheat sheet): card group, og:type and
// the JSON-LD shape differ.
const kind = marketingPageKind(target.slug)
const { imageUrl } = useMarketingSeo({
  title: page.title,
  description: page.description,
  imageGroup: kind === 'other' ? 'useCases' : 'compare',
  image: page.ogImage,
  imageAlt: page.ogImageAlt,
  type: kind === 'hub' ? 'website' : 'article',
  modifiedTime: page.updated,
  noindex: !indexable
})

// hreflang alternates for the reviewed language versions that exist;
// an unreviewed translation is noindex and lists none.
const alternates = indexable ? hreflangLinks(target.slug, versions) : []
useHead({
  link: siteUrl.value
    ? alternates.map(a => ({
        key: `hreflang-${a.hreflang}`,
        rel: 'alternate',
        hreflang: a.hreflang,
        href: `${siteUrl.value}${a.path}`
      }))
    : []
})

// JSON-LD (marketing site only): WebPage + BreadcrumbList, plus
//  - hub: CollectionPage + ItemList of the comparisons;
//  - comparison: Article `about` markoto and the other tool (no ratings);
//  - other pages: `about` markoto's SoftwareApplication, and HowTo when
//    the frontmatter lists steps.
const hubPath = marketingRoutePath(target.locale, COMPARE_HUB_SLUG)
const competitor = kind === 'page' ? target.slug.slice(COMPARE_HUB_SLUG.length + 1) : ''
// Same key as `::compare-facts`, so the page queries the claims once.
const { data: compareData } = await useAsyncData(
  `compare:${competitor || '-'}`,
  () => (competitor ? fetchCompareData(competitor) : Promise.resolve(null))
)
const { data: hubItems } = await useAsyncData(
  `marketing:hub:${target.locale}:${kind}`,
  () => (kind === 'hub' ? fetchCompareHubItems(target.locale) : Promise.resolve([]))
)
usePageStructuredData(() => {
  if (!indexable) return null
  const base = {
    name: page.title,
    description: page.description,
    dateModified: page.updated,
    image: imageUrl.value
  }
  if (kind === 'hub') {
    return {
      ...base,
      pageType: 'CollectionPage',
      breadcrumbs: pageBreadcrumbs(route.path, page.title),
      itemList: hubItems.value ?? []
    }
  }
  if (kind === 'page') {
    const other = compareData.value?.name
    return {
      ...base,
      article: 'Article',
      breadcrumbs: hubBreadcrumbs({ name: COMPARE_HUB_CRUMB, path: hubPath }, route.path, page.title),
      about: other ? [{ self: true }, { name: other }] : [{ self: true }]
    }
  }
  return {
    ...base,
    breadcrumbs: pageBreadcrumbs(route.path, page.title),
    about: [{ self: true }],
    howTo: page.howTo ?? undefined
  }
})

const updatedLabel = computed(() => {
  if (!page.updated) return ''
  const date = new Date(`${page.updated}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return ''
  return t('marketing.page.updated', {
    date: date.toLocaleDateString(locale.value, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  })
})
</script>

<template>
  <article
    class="px-4 sm:px-6 py-10 sm:py-16"
    :lang="target.locale"
    data-testid="marketing-page"
  >
    <!-- Notice and date: the body text's column (72ch of the body font,
         not the mono). -->
    <div
      v-if="!indexable"
      class="mx-auto max-w-[72ch]"
    >
      <p
        class="mb-6 rounded-md border border-default bg-default px-3 py-2 font-mono text-[11px] tracking-[0.04em] text-muted"
        data-testid="marketing-unreviewed"
      >
        {{ t('marketing.page.unreviewed') }}
      </p>
    </div>
    <ContentRenderer
      :value="page"
      class="mk-marketing__body prose dark:prose-invert max-w-none"
    />
    <div
      v-if="updatedLabel"
      class="mx-auto max-w-[72ch]"
    >
      <p class="mt-12 font-mono text-[11px] tracking-[0.04em] text-muted">
        {{ updatedLabel }}
      </p>
    </div>
  </article>
</template>

<style scoped>
/* The rendered Markdown's own elements, which no utility class reaches:
   same reading column as the docs (72ch) with opt-in wide blocks
   (`.mk-wide`: samples, flow strips, tables), and the display type of
   its headings. Everything else on this page is Tailwind utilities. */
.mk-marketing__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) min(72ch, 100%) minmax(0, 1fr);
}
.mk-marketing__body :deep(> *) {
  grid-column: 2;
}
/* Grid items don't collapse margins: without this, prose paragraphs
   got their bottom AND the next block's top margin (double gaps). The
   next block's top margin alone is the gap a collapsed margin gives.
   MDC blocks (`.not-prose`) set their own margins with utilities. */
.mk-marketing__body :deep(> :where(:not(.not-prose))) {
  margin-bottom: 0;
}
.mk-marketing__body :deep(> .mk-wide) {
  grid-column: 1 / -1;
  width: 100%;
  max-width: 1100px;
  justify-self: center;
}
.mk-marketing__body :deep(h1) {
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: clamp(34px, 5.5vw, 56px);
  line-height: 1.06;
  letter-spacing: -0.02em;
  margin-bottom: 0.4em;
}
.mk-marketing__body :deep(h2) {
  font-family: var(--font-serif);
  font-weight: 400;
  letter-spacing: -0.01em;
}
/* Headings carry their own anchor link (Nuxt Content); don't let the
   prose link underline make them look like links to elsewhere. */
.mk-marketing__body :deep(:is(h2, h3, h4) > a) {
  text-decoration: none;
}
</style>
