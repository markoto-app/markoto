<script setup lang="ts">
// `/settings` has no page of its own: it opens the first settings page.
// A 302 on the server render, a replace on client navigation. Signed out,
// the profile page sends the visitor on to sign in like every settings page.
const route = useRoute()
await navigateTo({ path: '/settings/profile', query: route.query, hash: route.hash }, { replace: true, redirectCode: 302 })
</script>

<template>
  <div />
</template>
