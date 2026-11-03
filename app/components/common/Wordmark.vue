<script setup lang="ts">
/**
 * The primary brand lockup. Renders the canonical SVG assets shipped
 * by the designer at `/public/markoto-logos/`:
 *
 *   - light: `primary-lockup-light.svg` — sumi paths + shu seal,
 *     transparent bg. Composites onto any warm light surface.
 *   - dark:  `primary-lockup-dark.svg`  — cream paths + brighter shu
 *     seal, sumi-950 bg baked in. We've flattened all dark-mode
 *     surfaces to sumi-950 (see main.css) so the rect blends.
 *
 * Both assets have the wordmark text outlined to paths, so they're
 * pixel-perfect from the first paint and don't depend on the Fraunces
 * web font loading. The SVG aspect ratio is 333×90; we
 * scale by `size` (height in px) and let the width follow.
 *
 * Hydration-safe color-mode swap: rather than picking the asset via
 * `useColorMode().value` (which differs between SSR and client and
 * triggers a Vue hydration warning that cascades into Suspense
 * misbehaviour on the home page), we render BOTH images and use CSS
 * to hide whichever doesn't match the current `.dark` class on
 * `<html>`. Same DOM on server and client, no swap-on-hydrate.
 */
withDefaults(defineProps<{
  /** Wordmark height in px. Width follows the 333×90 aspect ratio. */
  size?: number
}>(), {
  size: 18
})
</script>

<template>
  <span
    class="mk-wordmark"
    :style="{ height: `${size}px` }"
  >
    <img
      src="/markoto-logos/primary-lockup-light.svg"
      alt="markoto"
      class="mk-wordmark__img mk-wordmark__img--light"
      :style="{ height: `${size}px` }"
    >
    <img
      src="/markoto-logos/primary-lockup-dark.svg"
      alt=""
      aria-hidden="true"
      class="mk-wordmark__img mk-wordmark__img--dark"
      :style="{ height: `${size}px` }"
    >
  </span>
</template>

<!--
  No `scoped` attribute on this style block. Vue's scoped CSS
  compiles `:global(.dark) .mk-wordmark__img--dark` to a plain
  `.dark .mk-wordmark__img--dark` selector (no `[data-v-*]`
  attribute), but the default `.mk-wordmark__img--dark` rule keeps
  the attribute and ends up tied on specificity — and the source
  order tiebreaker isn't reliably winning, leaving the dark variant
  hidden in dark mode. Plain (un-scoped) styles avoid the dance
  entirely. The `mk-wordmark__*` class names are namespaced
  enough that leaking them globally is safe.
-->
<style>
.mk-wordmark {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  position: relative;
}
.mk-wordmark__img {
  width: auto;
  display: block;
}
/* Light by default; dark variant hidden until `.dark` lands on
   `<html>`. Server and client render the same DOM regardless of
   color mode — no hydration mismatch. */
.mk-wordmark__img--dark {
  display: none;
}
html.dark .mk-wordmark__img--light {
  display: none;
}
html.dark .mk-wordmark__img--dark {
  display: block;
}
</style>
