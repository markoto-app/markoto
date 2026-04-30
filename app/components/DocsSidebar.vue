<script setup lang="ts">
// Recursive sidebar that mirrors the content/docs/ folder structure.
// Folders render as <details> groups so collapsibility is native (no JS
// state to manage); each one is open-by-default IF the active route is
// inside it, so readers don't have to manually expand to find their
// current page.
//
// Filters out entries that mark `navHidden: true` in their frontmatter.
// Index pages typically set this — they're surfaced as the parent
// group's clickable header, not as a duplicate child link.

type NavItem = {
  title: string
  path: string
  // Nuxt Content's queryCollectionNavigation returns this shape; we
  // narrow `children` recursively here for our own consumption.
  children?: NavItem[]
  // Frontmatter passthrough. queryCollectionNavigation surfaces these
  // when the schema declares them.
  navHidden?: boolean
  order?: number
  icon?: string
}

defineProps<{
  nav: NavItem[]
}>()

const route = useRoute()

// True if `path` is the active route OR an ancestor of it. Used to
// auto-expand the branch containing the current page.
function isActiveBranch(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/')
}

function visible(items: NavItem[] | undefined): NavItem[] {
  if (!items) return []
  return items
    .filter(it => !it.navHidden)
    .sort((a, b) => {
      // Order field wins; otherwise alphabetical by title.
      const ao = a.order ?? Number.MAX_SAFE_INTEGER
      const bo = b.order ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
      return a.title.localeCompare(b.title)
    })
}
</script>

<template>
  <nav class="text-sm sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto">
    <ul class="space-y-0.5">
      <SidebarItem
        v-for="item in visible(nav)"
        :key="item.path"
        :item="item"
        :is-active-branch="isActiveBranch"
        :visible="visible"
      />
    </ul>
  </nav>
</template>
