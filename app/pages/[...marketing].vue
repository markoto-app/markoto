<script setup lang="ts">
import { hreflangLinks, isIndexableVersion } from '~~/shared/seo/marketing'
import { fetchMarketingPage } from '~/utils/marketingPage'

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
useMarketingSeo({
  title: page.title,
  description: page.description,
  image: page.ogImage
})

// hreflang alternates for the reviewed language versions that exist;
// an unreviewed translation is noindex and lists none.
const alternates = indexable ? hreflangLinks(target.slug, versions) : []
useHead({
  meta: indexable ? [] : [{ key: 'robots', name: 'robots', content: 'noindex, follow' }],
  link: siteUrl.value
    ? alternates.map(a => ({
        key: `hreflang-${a.hreflang}`,
        rel: 'alternate',
        hreflang: a.hreflang,
        href: `${siteUrl.value}${a.path}`
      }))
    : []
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
    class="mk-marketing px-4 sm:px-6 py-10 sm:py-16"
    :lang="target.locale"
    data-testid="marketing-page"
  >
    <div
      v-if="!indexable"
      class="mk-marketing__col"
    >
      <p
        class="mk-marketing__notice"
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
      class="mk-marketing__col"
    >
      <p class="mk-marketing__updated">
        {{ updatedLabel }}
      </p>
    </div>
  </article>
</template>

<style scoped>
/* Same reading column as the docs (72ch) with opt-in wide blocks
   (`.mk-wide`: samples, flow strips, tables). */
.mk-marketing__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) min(72ch, 100%) minmax(0, 1fr);
}
.mk-marketing__body :deep(> *) {
  grid-column: 2;
  /* Grid items don't collapse margins: without this, prose paragraphs
     got their bottom AND the next block's top margin (double gaps). The
     next block's top margin alone is the gap a collapsed margin gives. */
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
/* Same column as the body text (`ch` of the body font, not the mono). */
.mk-marketing__col {
  max-width: 72ch;
  margin-inline: auto;
}
.mk-marketing__notice,
.mk-marketing__updated {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--ui-text-muted);
}
.mk-marketing__notice {
  margin-bottom: 24px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-bg);
}
.mk-marketing__updated {
  margin-top: 48px;
}
</style>
