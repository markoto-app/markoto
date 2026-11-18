<template>
  <!-- Chart cards side by side from `lg` and in print; charts draw in the browser only. -->
  <ClientOnly>
    <div class="grid gap-3 lg:grid-cols-2 print:grid-cols-2">
      <slot />
    </div>
  </ClientOnly>
</template>
