<script setup lang="ts">
// One sidebar entry. Renders as either:
//   - a leaf <NuxtLink> (no children), or
//   - a <details> group whose <summary> is the parent's link and
//     whose body is a recursive list of children. Native <details>
//     means no JS state to manage; `open` is computed from whether
//     the active route is inside this branch.
//
// Self-recursive: a child group renders another <SidebarItem>.

type NavItem = {
  title: string
  path: string
  children?: NavItem[]
  navHidden?: boolean
  order?: number
  // Lucide icon name. Sections (folder index pages) set this in their
  // frontmatter; leaf pages typically don't.
  icon?: string
}

const props = defineProps<{
  item: NavItem
  isActiveBranch: (path: string) => boolean
  visible: (items: NavItem[] | undefined) => NavItem[]
}>()

// Strip out a child whose path matches the parent's own path,
// queryCollectionNavigation surfaces folder/index.md as both the
// parent group AND a child of itself. Without this filter every
// section header would render its own link twice (once as the
// expandable summary, once as the first child).
const visibleChildren = computed(() =>
  props.visible(props.item.children).filter(c => c.path !== props.item.path)
)
const hasChildren = computed(() => visibleChildren.value.length > 0)
const open = computed(() => props.isActiveBranch(props.item.path))
</script>

<template>
  <li>
    <details
      v-if="hasChildren"
      :open="open"
      class="group"
    >
      <summary
        class="flex items-center gap-2 cursor-pointer list-none select-none py-1.5 px-2 rounded hover:bg-elevated"
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="size-3 transition-transform shrink-0 group-open:rotate-90"
        />
        <UIcon
          v-if="item.icon"
          :name="item.icon"
          class="size-4 shrink-0 text-muted"
        />
        <NuxtLink
          :to="item.path"
          class="flex-1 truncate"
          :class="$route.path === item.path ? 'text-default font-medium' : ''"
          @click.stop
        >
          {{ item.title }}
        </NuxtLink>
      </summary>
      <ul class="ml-3 border-l border-default pl-3 mt-0.5 space-y-0.5">
        <SidebarItem
          v-for="child in visibleChildren"
          :key="child.path"
          :item="child"
          :is-active-branch="isActiveBranch"
          :visible="visible"
        />
      </ul>
    </details>
    <!-- A section that is a single page (no child list): same row as a
         section header, without the chevron. -->
    <NuxtLink
      v-else-if="item.icon"
      :to="item.path"
      class="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-elevated"
      :class="$route.path === item.path ? 'text-default font-medium' : ''"
    >
      <span
        class="size-3 shrink-0"
        aria-hidden="true"
      />
      <UIcon
        :name="item.icon"
        class="size-4 shrink-0 text-muted"
      />
      <span class="flex-1 truncate">{{ item.title }}</span>
    </NuxtLink>
    <NuxtLink
      v-else
      :to="item.path"
      class="block py-1 px-2 rounded hover:bg-elevated truncate"
      :class="$route.path === item.path ? 'text-default font-medium' : 'text-toned hover:text-default'"
    >
      {{ item.title }}
    </NuxtLink>
  </li>
</template>
