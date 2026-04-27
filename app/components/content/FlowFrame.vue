<script setup lang="ts">
// Single frame wrapped in a fake browser chrome (traffic lights +
// address bar). Body is either a screenshot (with cursor + outcome
// highlights) OR a chapter card (centered heading, no cursor). Both
// render at the source viewport's aspect ratio so overlays stay
// geometrically correct at any displayed width.

type Highlight = { label: string, x: number, y: number, w: number, h: number }
type Card = { kind: 'chapter' | 'narration', text: string } | null

const props = defineProps<{
  /** Image URL — null when rendering a card body. */
  src: string | null
  /** Card content — non-null swaps the body to a text card.
   *  `chapter` = big centered heading + "Chapter" label;
   *  `narration` = smaller centered prose, no label. */
  card: Card
  /** Cursor coords (CSS pixels relative to the source viewport). */
  cursor: { x: number, y: number } | null
  /** Cursor opacity 0..1 — fades the cursor across kind changes. */
  cursorOpacity: number
  /** URL pathname rendered in the fake address bar. Empty on chapter. */
  path: string
  /** Outcome-only callouts. Approach/narration ignore these. */
  highlights?: Highlight[]
  /** Source viewport size — drives aspect ratio + overlay scaling. */
  viewport: { w: number, h: number }
  showCursor: boolean
  showChrome: boolean
  chromeDomain: string
  showHighlights: boolean
}>()

// Emit a click only when the user clicks the IMAGE / CARD area —
// the browser chrome (traffic lights + address bar) is decorative
// and shouldn't toggle play. Flow.vue's click-to-toggle listens on
// this event rather than wrapping the whole frame.
defineEmits<{ click: [] }>()

const LABEL_FLIP_VERTICAL_PX = 28
function labelBelow(h: Highlight): boolean {
  return h.y < LABEL_FLIP_VERTICAL_PX
}
function labelRight(h: Highlight): boolean {
  return h.x > props.viewport.w / 2
}
</script>

<template>
  <figure>
    <div class="rounded-lg overflow-hidden border border-default bg-elevated shadow-sm">
      <!-- Browser chrome — kept across all slide kinds for visual
           continuity. Address bar shows "—" on chapter cards (no
           meaningful path). -->
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
          <span v-if="path" class="text-default truncate">{{ path }}</span>
          <span v-else class="text-muted">—</span>
        </div>
      </div>

      <!-- Body. Aspect ratio locked to the source viewport so overlays
           land in the right place at any displayed width. Cursor
           pointer + click handler scoped to this region so the
           chrome above stays decorative. -->
      <div
        class="relative bg-default cursor-pointer"
        :style="{ aspectRatio: `${viewport.w} / ${viewport.h}` }"
        role="button"
        :aria-label="card ? card.text : 'Toggle slideshow playback'"
        @click="$emit('click')"
      >
        <!-- Text card. Two variants:
             - chapter: big centered heading + "Chapter" eyebrow label
             - narration: smaller centered prose, no label —
               exposition between actions, not a section break. -->
        <div
          v-if="card"
          class="absolute inset-0 flex flex-col items-center justify-center px-12 bg-elevated/30"
        >
          <div
            v-if="card.kind === 'chapter'"
            class="text-xs uppercase tracking-widest text-muted mb-3"
          >
            Chapter
          </div>
          <p
            v-if="card.kind === 'chapter'"
            class="text-3xl md:text-5xl font-semibold text-default text-center leading-tight max-w-3xl"
          >
            {{ card.text }}
          </p>
          <p
            v-else
            class="text-base md:text-xl text-default text-center leading-relaxed max-w-2xl"
          >
            {{ card.text }}
          </p>
        </div>

        <!-- Screenshot + overlays. -->
        <template v-else-if="src">
          <img
            :src="src"
            alt=""
            loading="lazy"
            class="absolute inset-0 w-full h-full object-cover"
          >

          <!-- Highlight callouts (outcome only — Flow.vue passes []
               for any other kind). -->
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
              <div class="absolute inset-0 rounded flow-highlight-pulse" />
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

          <!-- Cursor. Opacity-controlled so it can fade out on
               chapter / narration without unmounting (preserves the
               element's identity across slides → CSS transition on
               left/top animates motion smoothly). -->
          <img
            v-if="showCursor && cursor"
            src="/flow-cursor.svg"
            alt=""
            aria-hidden="true"
            class="absolute pointer-events-none w-8 h-8 -translate-x-[2px] -translate-y-[2px] transition-[left,top,opacity] duration-300 ease-out"
            :style="{
              left: `${(cursor.x / viewport.w) * 100}%`,
              top: `${(cursor.y / viewport.h) * 100}%`,
              opacity: cursorOpacity,
              filter: 'drop-shadow(0 0 3px rgb(249 115 22 / 0.95)) drop-shadow(0 0 10px rgb(249 115 22 / 0.7))'
            }"
          >
        </template>
      </div>
    </div>
  </figure>
</template>

<style scoped>
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
@media (prefers-reduced-motion: reduce) {
  .flow-highlight-pulse {
    animation: none;
    box-shadow: 0 0 7px 2px rgb(249 115 22 / 0.7);
  }
}
</style>
