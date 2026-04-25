<script setup lang="ts">
// Single screenshot wrapped in a fake browser chrome (traffic lights +
// address bar) with overlays: a cursor + zero-or-more bounding-box
// highlights. Splitting this out of Flow.vue keeps the slides/scroll
// branching readable AND lets us reuse the rendering for either mode —
// the browser-bar markup, cursor overlay, and highlight maths belong
// here, not in the parent.

type Highlight = { label: string, x: number, y: number, w: number, h: number }

const props = defineProps<{
  src: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
  highlights?: Highlight[]
  viewport: { w: number, h: number }
  showCursor: boolean
  showChrome: boolean
  chromeDomain: string
  showHighlights: boolean
}>()

// Auto-flip the floating label so it never gets clipped by the
// frame's overflow-hidden border. Two axes:
//   - Vertical: above the box by default, below if too close to top.
//   - Horizontal: anchored to the LEFT of the box by default, to the
//     RIGHT if the box's left-edge is past the horizontal midpoint
//     (so the label grows leftward into the frame instead of running
//     off the right edge).
// Heuristics not pixel-perfect because we don't know the rendered
// label width until layout, but a midpoint check is good enough for
// the vast majority of real layouts.
const LABEL_FLIP_VERTICAL_PX = 28
function labelBelow(h: Highlight): boolean {
  return h.y < LABEL_FLIP_VERTICAL_PX
}
function labelRight(h: Highlight): boolean {
  return h.x > props.viewport.w / 2
}
</script>

<template>
  <figure class="space-y-2">
    <div class="rounded-lg overflow-hidden border border-default bg-elevated shadow-sm">
      <!-- ─── Browser chrome ─────────────────────────────────────────
           Traffic lights + a single address-bar pill. Minimal on
           purpose — no tabs, no back/forward — so the eye lands on
           the URL not the chrome. -->
      <div
        v-if="showChrome"
        class="flex items-center gap-2 px-3 py-2 bg-elevated border-b border-default"
      >
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="size-3 rounded-full bg-red-400/80" aria-hidden="true" />
          <span class="size-3 rounded-full bg-yellow-400/80" aria-hidden="true" />
          <span class="size-3 rounded-full bg-green-400/80" aria-hidden="true" />
        </div>
        <div
          class="flex-1 min-w-0 px-3 py-1 rounded-md bg-default border border-default text-xs font-mono truncate flex items-center gap-1"
        >
          <UIcon name="i-lucide-lock" class="size-3 text-muted shrink-0" />
          <span class="text-muted">{{ chromeDomain }}</span>
          <span class="text-default truncate">{{ path }}</span>
        </div>
      </div>

      <!-- ─── Screenshot + overlays ──────────────────────────────────
           aspect-ratio container locks the box to the source viewport
           shape, so cursor + highlight overlays stay geometrically
           correct at any displayed width. % positioning so everything
           scales with the container without JS. -->
      <div
        class="relative bg-default"
        :style="{ aspectRatio: `${viewport.w} / ${viewport.h}` }"
      >
        <img
          :src="src"
          :alt="caption"
          loading="lazy"
          class="absolute inset-0 w-full h-full object-cover"
        >

        <!-- Highlight callouts. Each is a dashed primary-colored
             outline + a label badge that floats above (or below if
             the box hugs the top). z-index keeps them above the
             screenshot but below the cursor — cursor wins focus. -->
        <template v-if="showHighlights && highlights?.length">
          <div
            v-for="(h, i) in highlights"
            :key="i"
            class="absolute pointer-events-none"
            :style="{
              left: `${(h.x / viewport.w) * 100}%`,
              top: `${(h.y / viewport.h) * 100}%`,
              width: `${(h.w / viewport.w) * 100}%`,
              height: `${(h.h / viewport.h) * 100}%`
            }"
          >
            <!-- Pulsating orange glow — no border. The animated
                 shadow makes it unambiguous that this is an
                 annotation overlay we added, not a UI element of
                 the app itself. Color matches the cursor (orange-500)
                 so the docs annotation language reads as one
                 cohesive system. -->
            <div class="absolute inset-0 rounded flow-highlight-pulse" />
            <!-- The label. Absolute-positioned to either above or
                 below the box, anchored to the box's left or right
                 edge depending on which side has more room. Truncates
                 if too long. Same orange palette as the glow. -->
            <span
              class="absolute px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500 text-white whitespace-nowrap max-w-[200px] truncate shadow"
              :class="[
                labelBelow(h) ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
                labelRight(h) ? 'right-0' : 'left-0'
              ]"
            >
              {{ h.label }}
            </span>
          </div>
        </template>

        <!-- Cursor overlay. Drawn last so it renders on top of any
             highlight box that happens to overlap.
             - Sized 32px (w-8) so it reads clearly even when the docs
               container is narrow.
             - Orange drop-shadow filter (Tailwind orange-500 alpha
               variants) makes the cursor pop against light AND dark
               screenshots without depending on theme.
             - CSS transition on left/top animates motion between
               slides — Vue keeps the same <img> element across slide
               changes (props update, not v-if churn), so the browser
               interpolates from the previous coords to the new ones.
               In scroll mode this is a no-op: each shot gets its own
               FlowFrame, so the element doesn't persist across them. -->
        <img
          v-if="showCursor && cursor"
          src="/flow-cursor.svg"
          alt=""
          aria-hidden="true"
          class="absolute pointer-events-none w-8 h-8 -translate-x-[2px] -translate-y-[2px] transition-[left,top] duration-300 ease-out"
          :style="{
            left: `${(cursor.x / viewport.w) * 100}%`,
            top: `${(cursor.y / viewport.h) * 100}%`,
            filter: 'drop-shadow(0 0 3px rgb(249 115 22 / 0.95)) drop-shadow(0 0 10px rgb(249 115 22 / 0.7))'
          }"
        >
      </div>
    </div>
    <figcaption class="text-sm text-toned">
      {{ caption }}
    </figcaption>
  </figure>
</template>

<style scoped>
/* Pulsating orange glow used by highlight callouts. Two stacked
   shadows: a tight ring that defines the box edge + a softer outer
   bloom that "breathes" outward. Using box-shadow rather than ring
   so we can animate spread/blur — those are GPU-accelerated. */
@keyframes flow-highlight-pulse {
  0%, 100% {
    box-shadow: 0 0 4px 1px rgb(249 115 22 / 0.6);
  }
  50% {
    box-shadow: 0 0 11px 4px rgb(249 115 22 / 0.75);
  }
}
.flow-highlight-pulse {
  animation: flow-highlight-pulse 1.8s ease-in-out infinite;
}
/* Honor reduced-motion: hold the brighter end-state so the highlight
   is still visible, just not animated. */
@media (prefers-reduced-motion: reduce) {
  .flow-highlight-pulse {
    animation: none;
    box-shadow: 0 0 7px 2px rgb(249 115 22 / 0.7);
  }
}
</style>
