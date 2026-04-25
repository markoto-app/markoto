<script setup lang="ts">
// Catch-all docs page. Resolves /docs/<...> against the `docs` collection
// and renders via <ContentRenderer>. The Flow component is auto-registered
// because it lives in app/components/content/, so MDC blocks like
// `::flow{id="create-document"}` Just Work inside any markdown page.
//
// Layout: shared docs shell (sidebar pinned to viewport left).
// Article grid: narrow center column for prose, opt-in full-bleed for
// elements with the `docs-wide` class. The Flow component uses it so
// screenshots render at full main-column width — comfortably readable —
// while prose stays narrow + readable in the center.

definePageMeta({ layout: 'docs' })

const route = useRoute()

const { data: page } = await useAsyncData(`docs:${route.path}`, () =>
  queryCollection('docs').path(route.path).first()
)

if (!page.value) {
  throw createError({ statusCode: 404, statusMessage: 'Doc not found' })
}

useSeoMeta({
  title: page.value.title,
  description: page.value.description
})
</script>

<template>
  <article
    v-if="page"
    class="prose dark:prose-invert px-6 md:px-12 py-12 max-w-none"
  >
    <!-- ContentRenderer wraps its output in a <div> by default. We
         pass `class` so that wrapper carries our grid styles —
         otherwise our `> *` selectors target the wrapper and never
         reach the actual content. -->
    <ContentRenderer
      :value="page"
      class="docs-content"
    />
  </article>
</template>

<style scoped>
/* Three-column grid lets narrow prose sit in the center column while
   opt-in full-bleed children (`.docs-wide`, used by the Flow
   component) span all three so screenshots get the full main-column
   width. The 1fr side columns shrink to nothing on narrow screens,
   keeping prose at its target width without overflowing. */
.docs-content {
  display: grid;
  grid-template-columns:
    minmax(0, 1fr)
    min(72ch, 100%)
    minmax(0, 1fr);
  column-gap: 0;
}
/* Default: every direct child sits in the narrow center column. */
.docs-content :deep(> *) {
  grid-column: 2;
}
/* Opt-in full-bleed for components that need to be visually wider
   than the prose. Currently the Flow component (screenshots), but
   other embeds (large diagrams, video demos) can use this too.
   Capped on ultra-wide monitors so flows don't lose proportion. */
.docs-content :deep(> .docs-wide) {
  grid-column: 1 / -1;
  max-width: 1400px;
  justify-self: center;
  width: 100%;
}
</style>
