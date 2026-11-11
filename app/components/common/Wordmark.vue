<script setup lang="ts">
/**
 * Primary brand lockup, rendered from the SVG assets in
 * `/public/markoto-logos/` (`primary-lockup-{light,dark}.svg`; the dark one
 * has a sumi-950 background baked in, matching the flattened dark surfaces
 * in main.css). The text is outlined to paths, so it doesn't wait for the
 * Fraunces web font. Aspect ratio is 333x90; `size` is the height in px.
 *
 * Both images are rendered and CSS hides the one that doesn't match the
 * `.dark` class on `<html>`. Picking via `useColorMode().value` differs
 * between SSR and client and causes a hydration warning that cascades into
 * Suspense misbehaviour.
 */
const props = withDefaults(defineProps<{
  /** Wordmark height in px. Width follows the 333×90 aspect ratio. */
  size?: number
}>(), {
  size: 18
})
// Intrinsic box for the <img> attributes (no layout shift while the SVG loads).
const width = computed(() => Math.round(props.size * 333 / 90))
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
      :width="width"
      :height="size"
      :style="{ height: `${size}px` }"
    >
    <img
      src="/markoto-logos/primary-lockup-dark.svg"
      alt=""
      aria-hidden="true"
      class="mk-wordmark__img mk-wordmark__img--dark"
      :width="width"
      :height="size"
      :style="{ height: `${size}px` }"
    >
  </span>
</template>

<!--
  Deliberately not `scoped`: scoped CSS compiles
  `:global(.dark) .mk-wordmark__img--dark` to a selector without `[data-v-*]`,
  which ties on specificity with the attribute-bearing default rule and can
  leave the dark variant hidden in dark mode. The `mk-wordmark__*` names are
  namespaced enough to leak globally.
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
