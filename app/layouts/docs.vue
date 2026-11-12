<script setup lang="ts">
// Shared shell for every /docs/* page.
//
// Desktop:
//   ┌──────────────────────────────────────────────────────────┐
//   │  Topbar (sticky)  brand   [search]    color-mode         │
//   ├──────────┬───────────────────────────────────────────────┤
//   │ Sidebar  │  <slot/>  (article + on-page TOC laid out by  │
//   │ (sticky) │           [...slug].vue)                      │
//   └──────────┴───────────────────────────────────────────────┘
// Mobile (≤md):
//   ┌──────────────────────────────────────────────────────────┐
//   │  ☰  brand   [search]                color-mode           │
//   ├──────────────────────────────────────────────────────────┤
//   │  <slot/>                                                 │
//   └──────────────────────────────────────────────────────────┘
//   ☰ opens a USlideover containing the same sidebar tree.
//
// We do nav + search-section fetching here so /docs/index AND
// /docs/[...slug] don't each re-query (it's the same data on both,
// and the search index lives at the layout level).

// Public reading pages: no modulepreload / prefetch hints in the HTML,
// the server render paints first and the code follows
// (useLeanResourceHints).
useLeanResourceHints()

const { data: navigation } = await useAsyncData('docs:nav', () =>
  queryCollectionNavigation('docs', ['order', 'navHidden', 'icon'])
)

// Search index — every page split into per-heading sections. Used
// only by UContentSearch (Cmd-K modal, client-only), so it is NOT part of
// the server render (~50 KB gzip per docs page): the
// browser fetches it once when search is about to open — pointer over /
// focus on the search button, or the modal opening (Cmd-K) — and keeps
// it across docs pages (same key).
const { open: searchOpen } = useContentSearch()
const { data: searchSections, status: searchStatus, execute: loadSearch } = useFetch('/api/_internal/docs-search', {
  key: 'docs:search',
  server: false,
  immediate: false
})
function warmSearch(): void {
  if (searchStatus.value === 'idle' || searchStatus.value === 'error') void loadSearch()
}
watch(searchOpen, (open) => {
  if (open) warmSearch()
})

// queryCollectionNavigation returns a single root "Docs" node whose
// children are our actual sections.
const sidebarNav = computed(() => {
  const nav = navigation.value
  if (!nav?.length) return []
  if (nav.length === 1 && nav[0]!.children?.length) return nav[0]!.children
  return nav
})

// Mobile drawer state. Closed by default; open via the hamburger.
const mobileNavOpen = ref(false)
// Auto-close on route change so navigating from inside the drawer
// doesn't leave it stranded over the new page.
const route = useRoute()
watch(() => route.path, () => {
  mobileNavOpen.value = false
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Sticky topbar. Holds brand, search trigger, and color-mode
         toggle on every viewport; adds a hamburger left of the brand
         on narrow widths so the sidebar drawer is always reachable.
         Sticks above the article body so search + nav stay one click
         away as readers scroll long pages. -->
    <header
      class="sticky top-0 z-30 flex items-center gap-3 px-4 md:px-6 h-14 border-b border-default/60 bg-muted/85 backdrop-blur-md"
    >
      <UButton
        class="md:hidden"
        icon="i-lucide-menu"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="$t('docs.openMenu')"
        @click="mobileNavOpen = true"
      />
      <!-- Topbar anchor: wordmark + hairline + Fraunces section
           name. The Back button used to live between the rules but
           cluttered the row — the wordmark itself links to /, so
           the affordance is preserved without the extra chrome. -->
      <NuxtLink
        to="/"
        class="flex items-center shrink-0"
        :aria-label="$t('common.homeLinkLabel')"
      >
        <CommonWordmark :size="20" />
      </NuxtLink>
      <span
        class="hidden sm:block w-px h-5 bg-default/60 shrink-0"
        aria-hidden="true"
      />
      <NuxtLink
        to="/docs"
        class="hidden sm:inline-flex font-serif text-lg font-normal tracking-tight text-default hover:text-muted transition-colors"
      >
        {{ $t('common.documentation') }}
      </NuxtLink>
      <!-- Search bar centered horizontally in the topbar regardless
           of viewport. `flex-1 justify-center` lets the input column
           absorb whatever space remains between the left anchor and
           the right group; the inner button caps at `max-w-md` so
           it stays a comfortable column width even on wide screens. -->
      <!-- `min-w-0` on both: without it the button's label + shortcut
           kbds set a min-content width and pushed the color-mode button
           past the edge on phones (page 428px wide at 375/390). -->
      <div class="flex-1 min-w-0 flex justify-center">
        <UContentSearchButton
          :collapsed="false"
          :label="$t('docs.searchLabel')"
          class="w-full min-w-0 max-w-md justify-start text-toned overflow-hidden"
          @pointerenter="warmSearch"
          @focus="warmSearch"
        />
      </div>
      <!-- AuthUserMenu carries: usage badge (tier + remaining
           interactions, ticks down live), avatar, name (hidden on
           mobile), pricing + logout dropdown. Same component as the
           homepage + editor, so docs readers see consistent identity
           UI everywhere they go. -->
      <AuthUserMenu />
      <UColorModeButton />
    </header>

    <div class="flex-1 grid md:grid-cols-[280px_1fr] min-h-0">
      <!-- Desktop sidebar — pinned to viewport left, sticky scroll.
           `bg-muted` matches every other chrome surface in the app
           (toolbar, status bar, sidebars in the editor) so the docs
           shell reads as part of the same instrument. -->
      <aside class="hidden md:block border-r border-default/60 bg-muted">
        <div class="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto p-5">
          <DocsSidebar :nav="sidebarNav" />
        </div>
      </aside>

      <main class="min-w-0">
        <slot />
      </main>
    </div>

    <!-- Docs, legal pages and imprint one click away, as on the home page. -->
    <CommonLegalFooter />

    <!-- Mobile sidebar drawer. Same nav tree, presented as a left-edge
         slideover that auto-closes on route change. Title slot keeps
         the heading consistent with the topbar's brand. -->
    <USlideover
      v-model:open="mobileNavOpen"
      side="left"
      :ui="{ content: 'max-w-[280px]' }"
      :title="$t('common.documentation')"
    >
      <template #body>
        <DocsSidebar
          :nav="sidebarNav"
          class="p-2"
        />
      </template>
    </USlideover>

    <!-- Search modal. Shortcut bound to Cmd/Ctrl-K (UContentSearch's
         default), but only mounted under the docs layout — won't
         hijack the hotkey on /d/<id> editor pages where Cmd-K is
         used by other UI. Files come from the search-sections
         payload; navigation feeds the per-section grouping. -->
    <ClientOnly>
      <LazyUContentSearch
        :files="searchSections ?? []"
        :navigation="sidebarNav"
      />
    </ClientOnly>
  </div>
</template>
