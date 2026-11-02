<script setup lang="ts">
// Single frame wrapped in a fake browser chrome (traffic lights +
// address bar). Body is either a screenshot (with cursor + outcome
// highlights) OR a chapter card (centered heading, no cursor). Both
// render at the source viewport's aspect ratio so overlays stay
// geometrically correct at any displayed width.

type Highlight = { label: string, x: number, y: number, w: number, h: number }
type AnnotationKind = 'arrow' | 'box' | 'pin'
type Annotation = {
  label: string
  kind: AnnotationKind
  x: number
  y: number
  w: number
  h: number
}
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
  /** Outcome-only callouts (pulsing orange ring + label). */
  highlights?: Highlight[]
  /** Direction-anchoring callouts on click targets (approach frames).
   *  Distinct from `highlights`: these point AT something the reader
   *  needs to act on next, not at something that just happened. */
  annotations?: Annotation[]
  /** Source viewport size — drives aspect ratio + overlay scaling. */
  viewport: { w: number, h: number }
  showCursor: boolean
  showChrome: boolean
  chromeDomain: string
  showHighlights: boolean
  /** When true, render the cursor as a grey tap circle (Chrome-DevTools-
   *  style touch-emulation indicator) instead of the orange mouse SVG.
   *  Mobile manifests don't have a real mouse cursor — a tap circle is
   *  more honest about how the user actually interacts. */
  isTouch?: boolean
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

// Annotation positioning — same flip logic as highlights but stricter
// because annotation labels live OFF-target (with a leader line) rather
// than hugging the box edge. Decide which corner the label sits in.
function annotationLabelLeft(a: Annotation): boolean {
  return a.x + a.w / 2 > props.viewport.w / 2
}
function annotationLabelTop(a: Annotation): boolean {
  return a.y + a.h / 2 > props.viewport.h / 2
}

// Leader-line endpoints for arrow-kind annotations. Currently
// unused — annotation rendering is disabled in the public docs
// slideshow (the SVG block is gated on `v-if="false"`). Kept here
// alongside lineToRectEdge so the rendering can be re-enabled
// without re-deriving the geometry. The leading underscore is
// what the lint rule expects for "intentionally unused".
function _arrowGeometry(a: Annotation) {
  const cx = a.x + a.w / 2
  const cy = a.y + a.h / 2
  const labelLeft = annotationLabelLeft(a)
  const labelTop = annotationLabelTop(a)
  // Tail anchor: a fixed inset from whichever corner the label's in.
  const inset = 18
  const tailX = labelLeft ? inset : props.viewport.w - inset
  const tailY = labelTop ? inset : props.viewport.h - inset
  // Arrowhead lands on the box edge closest to the tail anchor —
  // computed via line-rect intersection. Keeps the arrow short and
  // clean instead of cutting through the target.
  const head = lineToRectEdge(tailX, tailY, cx, cy, a)
  return { tailX, tailY, headX: head.x, headY: head.y, labelLeft, labelTop }
}

/**
 * If the parametric line `(origin + t*delta)` crosses `axisValue` at
 * t ∈ [0, 1] AND the perpendicular coordinate at that t falls inside
 * `[perpMin, perpMax]`, return t; else null. Used to test whether a
 * directed line segment touches one edge of an axis-aligned rect.
 */
function intersectAxis(
  origin: number,
  delta: number,
  axisValue: number,
  perpOrigin: number,
  perpDelta: number,
  perpMin: number,
  perpMax: number
): number | null {
  if (delta === 0) return null
  const t = (axisValue - origin) / delta
  if (t < 0 || t > 1) return null
  const perp = perpOrigin + t * perpDelta
  return (perp >= perpMin && perp <= perpMax) ? t : null
}

// Intersect line (x1, y1) → (x2, y2) with the bounding rect of the
// annotation. Returns the point where the line first touches the
// rect's perimeter (so the arrowhead lands on the edge, not in the
// box's interior).
function lineToRectEdge(x1: number, y1: number, x2: number, y2: number, a: Annotation) {
  const left = a.x
  const right = a.x + a.w
  const top = a.y
  const bottom = a.y + a.h
  const dx = x2 - x1
  const dy = y2 - y1
  // Param t in [0, 1] where line first crosses the rect. Compute
  // candidate t for each edge; pick the smallest valid one.
  const candidates = [
    intersectAxis(x1, dx, left, y1, dy, top, bottom),
    intersectAxis(x1, dx, right, y1, dy, top, bottom),
    intersectAxis(y1, dy, top, x1, dx, left, right),
    intersectAxis(y1, dy, bottom, x1, dx, left, right)
  ].filter((v): v is number => v !== null)
  const t = candidates.length ? Math.min(...candidates) : 1
  return { x: x1 + t * dx, y: y1 + t * dy }
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
          <span
            class="size-3 rounded-full bg-red-400/80"
            aria-hidden="true"
          />
          <span
            class="size-3 rounded-full bg-yellow-400/80"
            aria-hidden="true"
          />
          <span
            class="size-3 rounded-full bg-green-400/80"
            aria-hidden="true"
          />
        </div>
        <div
          class="flex-1 min-w-0 px-3 py-1 rounded-md bg-default border border-default text-xs font-mono truncate flex items-center gap-1"
        >
          <UIcon
            name="i-lucide-lock"
            class="size-3 text-muted shrink-0"
          />
          <!-- A path without a leading "/" is a non-app location (a
               downloaded file shown in a viewer): no app domain. -->
          <span
            v-if="!path || path.startsWith('/')"
            class="text-muted"
          >{{ chromeDomain }}</span>
          <span
            v-if="path"
            class="text-default truncate"
          >{{ path }}</span>
          <span
            v-else
            class="text-muted"
          >—</span>
        </div>
      </div>

      <!-- Body. Aspect ratio locked to the source viewport so overlays
           land in the right place at any displayed width. Cursor
           pointer + click handler scoped to this region so the
           chrome above stays decorative. -->
      <button
        type="button"
        class="block w-full text-left relative bg-default cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-shu-500"
        :style="{ aspectRatio: `${viewport.w} / ${viewport.h}` }"
        :aria-label="card ? card.text : 'Toggle slideshow playback'"
        @click="$emit('click')"
      >
        <!-- Text card. Two variants:
             - chapter: huge Fraunces serif headline (display register
               with optional italic emphasis) + JetBrains Mono eyebrow
               separator, centered on a warm bone field. The previous
               `font-semibold` Inter at 5xl read "developer slide
               deck"; the new register reads "field-guide chapter
               title" — same display voice as the homepage hero.
             - narration: smaller centered prose, exposition between
               actions, not a section break. -->
        <div
          v-if="card"
          class="absolute inset-0 flex flex-col items-center justify-center px-12 bg-muted"
        >
          <div
            v-if="card.kind === 'chapter'"
            class="flex items-center gap-2.5 mb-6 font-mono text-[11px] tracking-[0.06em] uppercase text-muted"
          >
            <span
              class="block w-[22px] h-px bg-current opacity-60"
              aria-hidden="true"
            />
            <span>chapter</span>
          </div>
          <p
            v-if="card.kind === 'chapter'"
            class="font-serif font-light text-default text-center leading-[1.06] tracking-tight max-w-4xl"
            style="font-size: clamp(36px, 5.5vw, 64px);"
          >
            {{ card.text }}
          </p>
          <!-- Narration card. Sized up from `text-base/xl` to a
               proper editorial body — readers used the previous size
               only because chapter cards dwarfed it; on its own the
               smaller text felt cramped on a full-frame slide. The
               clamp() gives it responsive scaling without breakpoints. -->
          <p
            v-else
            class="text-default text-center leading-relaxed max-w-3xl"
            style="font-size: clamp(18px, 2.4vw, 28px); line-height: 1.4;"
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
               for any other kind). Color: shu (the markoto seal) so
               the callouts read as part of the brand surface, not
               like a generic warning chip. -->
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
                class="absolute px-1.5 py-0.5 rounded text-[10px] font-medium text-white whitespace-nowrap max-w-[200px] truncate shadow"
                :class="[
                  labelBelow(h) ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
                  labelRight(h) ? 'right-0' : 'left-0'
                ]"
                :style="{ background: 'var(--color-shu-500, #B5371F)' }"
              >
                {{ h.label }}
              </span>
            </div>
          </template>

          <!-- Annotation rendering DISABLED in the public docs slideshow.
               The fixture + manifest still ship `annotations` (so future
               work can re-enable arrow/box/pin overlays without churning
               every spec), but feedback was that arrows spanning the
               whole slide read as visual noise — the cursor + highlight
               boxes carry enough direction. To re-enable, uncomment the
               original block in git history (commit c22b7e3) and ensure
               the props pipeline still passes the array through. -->
          <template v-if="false && annotations?.length">
            <!-- intentionally empty — annotations live in manifests but
                 are not rendered in the slideshow today -->
          </template>

          <!-- Cursor / tap indicator. Opacity-controlled so it can
               fade out on chapter / narration without unmounting
               (preserves the element's identity across slides → CSS
               transition on left/top animates motion smoothly).
               Touch variant: a 32px translucent grey circle (Chrome
               DevTools' touch-emulation indicator) — there's no real
               mouse cursor on mobile. -->
          <div
            v-if="showCursor && cursor && isTouch"
            class="absolute pointer-events-none size-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-400/55 ring-2 ring-neutral-700/60 transition-[left,top,opacity] duration-300 ease-out"
            aria-hidden="true"
            :style="{
              left: `${(cursor.x / viewport.w) * 100}%`,
              top: `${(cursor.y / viewport.h) * 100}%`,
              opacity: cursorOpacity
            }"
          />
          <img
            v-else-if="showCursor && cursor"
            src="/flow-cursor.svg"
            alt=""
            aria-hidden="true"
            class="absolute pointer-events-none w-8 h-8 -translate-x-[2px] -translate-y-[2px] transition-[left,top,opacity] duration-300 ease-out"
            :style="{
              left: `${(cursor.x / viewport.w) * 100}%`,
              top: `${(cursor.y / viewport.h) * 100}%`,
              opacity: cursorOpacity,
              // shu-500 (#B5371F = rgb(181 55 31)) — the markoto seal
              // color. Was generic orange-500 before; switched so the
              // cursor's glow reads as brand surface, not as a warning.
              filter: 'drop-shadow(0 0 3px rgb(181 55 31 / 0.95)) drop-shadow(0 0 10px rgb(181 55 31 / 0.7))'
            }"
          >
        </template>
      </button>
    </div>
  </figure>
</template>

<style scoped>
/* shu-500 (#B5371F = rgb(181 55 31)) — the markoto seal color. The
   pulse glow was generic orange-500; switched to shu so highlights
   match the brand palette. The chip background (set inline above)
   uses the same value. */
@keyframes flow-highlight-pulse {
  0%, 100% {
    box-shadow: 0 0 4px 1px rgb(181 55 31 / 0.6);
  }
  50% {
    box-shadow: 0 0 11px 4px rgb(181 55 31 / 0.75);
  }
}
.flow-highlight-pulse {
  animation: flow-highlight-pulse 1.8s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .flow-highlight-pulse {
    animation: none;
    box-shadow: 0 0 7px 2px rgb(181 55 31 / 0.7);
  }
}
</style>
