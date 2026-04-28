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
 * pixel-perfect from the first paint and don't depend on Fraunces
 * loading from Google Fonts. The SVG aspect ratio is 333×90; we
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

<style scoped>
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
/* Light by default, dark when `.dark` is on <html>. The dark variant
   is hidden via display:none in light mode and shown in dark mode;
   light variant the inverse. Server and client render the same DOM
   regardless of color mode — no hydration mismatch. */
.mk-wordmark__img--dark {
  display: none;
}
:global(.dark) .mk-wordmark__img--light {
  display: none;
}
:global(.dark) .mk-wordmark__img--dark {
  display: block;
}
</style>
