<template>
  <!-- The KPI tile grid: two columns on phones, four from `lg` and in print. -->
  <div class="grid grid-cols-2 lg:grid-cols-4 print:grid-cols-4 gap-3">
    <slot />
  </div>
</template>
