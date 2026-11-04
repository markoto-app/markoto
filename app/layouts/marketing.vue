<script setup lang="ts">
// Shell of the public pages other than `/`: /pricing and the marketing
// content pages (pages/[...marketing].vue). Same header as the home page
// (MarketingHeader) plus a "Start writing" button, and the site footer
// with the marketing + legal links. Page ground `bg-muted`, as on the home
// page (and the dark lockup's baked-in sumi-950 needs it).
</script>

<template>
  <div class="min-h-[100dvh] flex flex-col bg-muted text-default">
    <MarketingHeader start />
    <main class="flex-1 min-w-0">
      <slot />
    </main>
    <CommonLegalFooter />
  </div>
</template>
