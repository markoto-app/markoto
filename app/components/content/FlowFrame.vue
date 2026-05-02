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

// Leader-line endpoints for arrow-kind annotations. The label sits
// in a corner of the slide; the arrow's tail is anchored at the
// label's near-edge, the head lands on the closest edge of the
// target box. Working in viewport CSS coordinates (the SVG is
// painted at `viewBox="0 0 W H"` so coords pass through directly).
function arrowGeometry(a: Annotation) {
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
  const candidates: number[] = []
  if (dx !== 0) {
    const tLeft = (left - x1) / dx
    if (tLeft >= 0 && tLeft <= 1) {
      const y = y1 + tLeft * dy
      if (y >= top && y <= bottom) candidates.push(tLeft)
    }
    const tRight = (right - x1) / dx
    if (tRight >= 0 && tRight <= 1) {
      const y = y1 + tRight * dy
      if (y >= top && y <= bottom) candidates.push(tRight)
    }
  }
  if (dy !== 0) {
    const tTop = (top - y1) / dy
    if (tTop >= 0 && tTop <= 1) {
      const x = x1 + tTop * dx
      if (x >= left && x <= right) candidates.push(tTop)
    }
    const tBottom = (bottom - y1) / dy
    if (tBottom >= 0 && tBottom <= 1) {
      const x = x1 + tBottom * dx
      if (x >= left && x <= right) candidates.push(tBottom)
    }
  }
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
          <span class="text-muted">{{ chromeDomain }}</span>
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
      <div
        class="relative bg-default cursor-pointer"
        :style="{ aspectRatio: `${viewport.w} / ${viewport.h}` }"
        role="button"
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

          <!-- Annotation callouts (direction-anchoring on click
               targets). Rendered as either:
                 • arrow — labelled SVG arrow from a slide corner
                 • box   — static dashed outline + adjacent label
                 • pin   — small numbered shu disc at top-left
               Distinct visual treatment from highlights (no pulse,
               no orange — these are "find this", not "celebrate
               this"). The shu palette anchors them to the markoto
               brand (the seal IS direction). -->
          <template v-if="annotations?.length">
            <!-- Single SVG layer for all arrow-kind annotations.
                 viewBox matches the source viewport so coordinates
                 pass through unscaled; the SVG itself stretches to
                 the frame body via 100%/100%. -->
            <svg
              v-if="annotations.some(a => a.kind === 'arrow')"
              class="absolute inset-0 w-full h-full pointer-events-none"
              :viewBox="`0 0 ${viewport.w} ${viewport.h}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="annot-arrowhead"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 0 L 10 5 L 0 10 z"
                    fill="var(--color-shu-500, #B5371F)"
                  />
                </marker>
              </defs>
              <template
                v-for="(a, i) in annotations"
                :key="`arrow-${i}`"
              >
                <line
                  v-if="a.kind === 'arrow'"
                  :x1="arrowGeometry(a).tailX"
                  :y1="arrowGeometry(a).tailY"
                  :x2="arrowGeometry(a).headX"
                  :y2="arrowGeometry(a).headY"
                  stroke="var(--color-shu-500, #B5371F)"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  marker-end="url(#annot-arrowhead)"
                />
              </template>
            </svg>

            <!-- Per-annotation HTML overlay: label tag for arrows
                 (positioned at the tail), dashed box for box-kind,
                 pin disc for pin-kind. -->
            <template
              v-for="(a, i) in annotations"
              :key="`annot-${i}`"
            >
              <!-- arrow: label at tail -->
              <span
                v-if="a.kind === 'arrow'"
                class="absolute pointer-events-none px-1.5 py-0.5 rounded font-mono text-[10.5px] tracking-[0.04em] uppercase bg-shu-500 text-white whitespace-nowrap max-w-[200px] truncate shadow-sm"
                :style="{
                  left: annotationLabelLeft(a)
                    ? '8px'
                    : 'auto',
                  right: annotationLabelLeft(a)
                    ? 'auto'
                    : '8px',
                  top: annotationLabelTop(a)
                    ? '4px'
                    : 'auto',
                  bottom: annotationLabelTop(a)
                    ? 'auto'
                    : '4px'
                }"
              >
                {{ a.label }}
              </span>

              <!-- box: dashed outline + adjacent label -->
              <div
                v-else-if="a.kind === 'box'"
                class="absolute pointer-events-none border-2 border-dashed rounded"
                :style="{
                  left: `${(a.x / viewport.w) * 100}%`,
                  top: `${(a.y / viewport.h) * 100}%`,
                  width: `${(a.w / viewport.w) * 100}%`,
                  height: `${(a.h / viewport.h) * 100}%`,
                  borderColor: 'var(--color-shu-500, #B5371F)'
                }"
              >
                <span
                  class="absolute px-1.5 py-0.5 rounded font-mono text-[10.5px] tracking-[0.04em] uppercase bg-shu-500 text-white whitespace-nowrap max-w-[200px] truncate shadow-sm"
                  :class="[
                    a.y < LABEL_FLIP_VERTICAL_PX ? 'top-full mt-0.5' : 'bottom-full mb-0.5',
                    a.x > viewport.w / 2 ? 'right-0' : 'left-0'
                  ]"
                >
                  {{ a.label }}
                </span>
              </div>

              <!-- pin: small disc at top-left of target -->
              <span
                v-else-if="a.kind === 'pin'"
                class="absolute pointer-events-none size-5 rounded-full flex items-center justify-center text-white text-[10px] font-mono shadow"
                :style="{
                  left: `${(a.x / viewport.w) * 100}%`,
                  top: `${(a.y / viewport.h) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  background: 'var(--color-shu-500, #B5371F)'
                }"
                :title="a.label"
              >
                {{ i + 1 }}
              </span>
            </template>
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
