<script setup lang="ts">
// Catch-all docs page. Resolves /docs/<...> against the `docs` collection
// and renders via <ContentRenderer>. The Flow component is auto-registered
// because it lives in app/components/content/, so MDC blocks like
// `::flow{id="create-document"}` Just Work inside any markdown page.

const route = useRoute()

const { data: page } = await useAsyncData(`docs:${route.path}`, () =>
  queryCollection('docs').path(route.path).first()
)

const { data: navigation } = await useAsyncData('docs:nav', () =>
  queryCollectionNavigation('docs')
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
  <div class="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-8">
    <aside class="hidden md:block">
      <DocsSidebar :nav="navigation ?? []" />
    </aside>
    <article class="prose dark:prose-invert max-w-3xl">
      <ContentRenderer v-if="page" :value="page" />
    </article>
  </div>
</template>
