<script setup lang="ts">
/**
 * A quiet browser window around a tour visual: hairline border, a bar
 * with three dots and the address. The body keeps the capture's aspect
 * ratio (or the phone focus crop's) so nothing shifts while images load.
 */
defineProps<{
  /** CSS aspect-ratio of the body, e.g. "1280 / 800". */
  ratio: string
  /**
   * Aspect ratio on phones (< 640px), when the visual shows a focus crop.
   * The product tour passes none: phones show the whole window (the crops
   * cut through the editor and the pages).
   */
  phoneRatio?: string
}>()
</script>

<template>
  <div
    class="mk-frame"
    :class="{ 'mk-frame--crop': phoneRatio }"
  >
    <div
      class="mk-frame__bar"
      aria-hidden="true"
    >
      <span class="mk-frame__dots"><i /><i /><i /></span>
      <span class="mk-frame__url">markoto.app</span>
      <span class="mk-frame__dots mk-frame__dots--ghost"><i /><i /><i /></span>
    </div>
    <div
      class="mk-frame__body"
      :style="{ '--mk-ratio': ratio, '--mk-phone-ratio': phoneRatio ?? ratio }"
    >
      <slot />
    </div>
  </div>
</template>

<style>
/* Colours come from the tour's tokens (assets/css/productTour.css), so the window
   turns with the page's light → dark flip. */
.mk-frame {
  container-type: inline-size;
  border: 1px solid var(--mk-rule, var(--color-sumi-200));
  border-radius: 14px;
  overflow: hidden;
  background: var(--mk-bg, var(--color-sumi-50));
  /* An ambient halo, not a card lift: the window should read as an
     object on the paper, so it gets the faintest falloff. */
  box-shadow: 0 1px 0 rgb(20 17 13 / 0.03), 0 40px 90px -60px rgb(20 17 13 / calc(0.45 + 0.45 * var(--mk-dark, 0)));
}
.mk-frame__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: clamp(24px, 4.2cqw, 34px);
  padding-inline: clamp(10px, 1.6cqw, 14px);
  border-bottom: 1px solid var(--mk-rule, var(--color-sumi-200));
  background: var(--mk-frame-bar, var(--color-sumi-100));
}
.mk-frame__dots {
  display: inline-flex;
  gap: clamp(4px, 0.8cqw, 7px);
}
.mk-frame__dots i {
  width: clamp(6px, 1cqw, 9px);
  aspect-ratio: 1;
  border-radius: 999px;
  background: var(--mk-frame-dot, var(--color-sumi-300));
}
.mk-frame__dots--ghost { visibility: hidden; }
.mk-frame__url {
  font-family: var(--font-mono);
  font-size: clamp(9px, 1.25cqw, 11px);
  letter-spacing: 0.04em;
  color: var(--mk-muted, var(--color-sumi-500));
  padding: 2px clamp(10px, 3cqw, 28px);
  border-radius: 999px;
  background: var(--mk-bg, var(--color-sumi-50));
}
.mk-frame__body {
  position: relative;
  aspect-ratio: var(--mk-ratio);
  overflow: hidden;
}
@media (max-width: 639px) {
  .mk-frame { border-radius: 12px; }
  /* A focus crop isn't the whole window: the window chrome would only
     take height from it. */
  .mk-frame--crop .mk-frame__bar { display: none; }
  .mk-frame__body { aspect-ratio: var(--mk-phone-ratio); }
}
</style>
