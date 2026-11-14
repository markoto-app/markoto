<script setup lang="ts">
// Recursive sidebar that mirrors the content/docs/ folder structure.
// Folders render as <details> groups so collapsibility is native (no JS
// state to manage); each one is open-by-default IF the active route is
// inside it, so readers don't have to manually expand to find their
// current page.
//
// Filters out entries that mark `navHidden: true` in their frontmatter.
// Index pages typically set this, they're surfaced as the parent
// group's clickable header, not as a duplicate child link.

import { sortDocsNav, type DocsNavNode } from '~~/shared/docs/docsSections'

defineProps<{
  nav: DocsNavNode[]
}>()

const route = useRoute()

// True if `path` is the active route OR an ancestor of it. Used to
// auto-expand the branch containing the current page.
function isActiveBranch(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/')
}
</script>

<template>
  <nav class="text-sm sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto">
    <ul class="space-y-0.5">
      <SidebarItem
        v-for="item in sortDocsNav(nav)"
        :key="item.path"
        :item="item"
        :is-active-branch="isActiveBranch"
      />
    </ul>
  </nav>
</template>
