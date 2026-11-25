<script setup lang="ts">
import { DEMO_VIDEO } from '~~/shared/media/demoVideo'

/**
 * The play affordance over the hero's product picture: a button covering
 * the window with a round play mark and a visible label in its middle. It
 * opens the demo video (ProductTour.vue owns the overlay). `data-early-click`
 * replays a click that lands before hydration (utils/platform/earlyClicks.ts).
 */
const emit = defineEmits<{ open: [trigger: HTMLElement], warm: [] }>()
const { t } = useI18n()
const minutes = Math.max(1, Math.round(DEMO_VIDEO.durationSeconds / 60))

function onClick(e: MouseEvent): void {
  emit('open', e.currentTarget as HTMLElement)
}
</script>

<template>
  <button
    type="button"
    class="mk-play"
    aria-haspopup="dialog"
    data-early-click
    @click="onClick"
    @pointerenter="emit('warm')"
    @focus="emit('warm')"
  >
    <span class="mk-play__pill">
      <span
        class="mk-play__disc"
        aria-hidden="true"
      >
        <UIcon
          name="i-lucide-play"
          class="mk-play__icon"
        />
      </span>
      <span class="mk-play__label">{{ t('tour.hero.watchDemo', { n: minutes }) }}</span>
    </span>
  </button>
</template>

<style>
/* Over the frame body (position: relative). Colours from the tour's tokens. */
.mk-play {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 4cqw, 40px);
  background: transparent;
  transition: background-color 200ms ease;
}
.mk-play:hover { background: rgb(20 17 13 / 0.06); }
.mk-play__pill {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 8px 18px 8px 8px;
  border: 1px solid var(--mk-chip-border, var(--color-sumi-200));
  border-radius: 999px;
  background: var(--mk-bg, var(--color-sumi-50));
  color: var(--mk-ink, var(--color-sumi-900));
  box-shadow: 0 18px 40px -24px rgb(20 17 13 / 0.55);
  transition: transform 200ms ease, border-color 200ms ease;
}
.mk-play:hover .mk-play__pill { border-color: var(--mk-ink-soft, var(--color-sumi-500)); }
.mk-play:focus-visible { outline: none; }
.mk-play:focus-visible .mk-play__pill {
  outline: 2px solid var(--mk-ink, var(--color-sumi-900));
  outline-offset: 3px;
}
.mk-play__disc {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  background: var(--mk-ink, var(--color-sumi-900));
  color: var(--mk-bg, var(--color-sumi-50));
}
.mk-play__icon {
  width: 18px;
  height: 18px;
  translate: 1px 0;
}
.mk-play__label {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
}
@media (prefers-reduced-motion: no-preference) {
  .mk-play:hover .mk-play__pill { transform: scale(1.03); }
}
@media (max-width: 639px) {
  .mk-play__pill { gap: 10px; padding: 6px 14px 6px 6px; }
  .mk-play__disc { width: 34px; height: 34px; }
  .mk-play__label { font-size: 14px; }
}
</style>
