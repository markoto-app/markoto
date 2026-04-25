<script setup lang="ts">
// Renders the tree returned by queryCollectionNavigation('docs') as a
// nested sidebar. Two levels deep is plenty for now; nest deeper by
// recursion if the docs grow more complex.

defineProps<{
  nav: Array<{
    title: string
    path: string
    children?: Array<{ title: string, path: string }>
  }>
}>()
</script>

<template>
  <nav class="text-sm sticky top-8">
    <ul class="space-y-1">
      <li v-for="item in nav" :key="item.path">
        <NuxtLink
          :to="item.path"
          class="block py-1 px-2 rounded hover:bg-elevated"
          active-class="text-primary font-medium"
        >
          {{ item.title }}
        </NuxtLink>
        <ul v-if="item.children?.length" class="ml-3 border-l border-default pl-3 mt-1 space-y-0.5">
          <li v-for="c in item.children" :key="c.path">
            <NuxtLink
              :to="c.path"
              class="block py-0.5 px-2 text-toned rounded hover:bg-elevated hover:text-default"
              active-class="text-primary font-medium"
            >
              {{ c.title }}
            </NuxtLink>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
