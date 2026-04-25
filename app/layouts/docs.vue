<script setup lang="ts">
// Shared shell for every /docs/* page. Two columns:
//   - LEFT: sidebar pinned to the viewport's left edge (no centered
//     wrapper margin). Sticky position so it stays visible while the
//     reader scrolls long pages. Border-right separates it from
//     content; subtle bg tint sets it apart without competing for
//     attention with the content.
//   - RIGHT: main content area. NO max-width on the outer column —
//     each page (or the article-grid CSS in [...slug].vue) controls
//     its own inner width so prose stays narrow + readable while
//     wide content (flows) can extend.
//
// We do nav fetching here so /docs/index AND /docs/[...slug] don't
// each re-query (it's the same data on both).

const { data: navigation } = await useAsyncData('docs:nav', () =>
  queryCollectionNavigation('docs', ['order', 'navHidden'])
)

// queryCollectionNavigation returns a single root "Docs" node whose
// children are our actual sections. The /docs link in the sidebar
// header already covers the root, so we render the children directly
// as top-level sidebar entries — no redundant "Docs" parent line.
const sidebarNav = computed(() => {
  const nav = navigation.value
  if (!nav?.length) return []
  // Single root w/ children → use children. Otherwise (multiple roots
  // — shouldn't happen with our schema, but defensive) → use as-is.
  if (nav.length === 1 && nav[0]!.children?.length) return nav[0]!.children
  return nav
})
</script>

<template>
  <div class="grid md:grid-cols-[280px_1fr] min-h-screen">
    <aside class="hidden md:block border-r border-default bg-elevated/30">
      <div class="sticky top-0 max-h-screen overflow-y-auto p-5">
        <NuxtLink
          to="/docs"
          class="flex items-center gap-2 mb-6 font-semibold hover:text-primary transition-colors"
        >
          <UIcon name="i-lucide-book-open" class="size-5 text-primary" />
          Documentation
        </NuxtLink>
        <DocsSidebar :nav="sidebarNav" />
      </div>
    </aside>

    <main class="min-w-0">
      <slot />
    </main>
  </div>
</template>
