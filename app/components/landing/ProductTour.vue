<script setup lang="ts">
import { coverRange, restOffsetVh, stageSideKeyframes, type TourScene } from '~~/shared/tour/manifest'
import { TOUR_DARK_FROM } from '~~/shared/tour/config'

/**
 * markoto.app's product page: shown at `/` to logged-out visitors
 * when the instance enables it (`NUXT_MARKETING_SITE_ENABLED`, see
 * `shared/config/instance.ts`). Hero → nine scenes → closing CTA. Each
 * scene's picture is a short looping video recorded from the real app.
 *
 * CSS does the choreography (stylesheet below):
 *  - Desktop (≥ 1024px) with scroll-driven animations and no
 *    reduced-motion preference: ONE browser window. Under the hero it sits
 *    centred; scrolling out of the hero carries it (transforms on a
 *    `scroll()` timeline) to the sticky stage, where it becomes scene 1.
 *    From there it alternates sides — odd scenes right, even scenes left —
 *    sliding across while one scene's copy fades out and the next one's
 *    fades in on the free side (generated keyframes on the track's view
 *    timeline, `stageSideKeyframes`). Every scene section names a view
 *    timeline (`--mk-s-<i>`, lifted to the track by `timeline-scope`)
 *    that cross-fades the stage layers and the copy. At the end the window
 *    leaves before the closing section.
 *  - Phones / tablets: each scene is one screen — its copy, then its own
 *    window (the phone cut of the video).
 *  - No scroll-driven animations (older Safari / Firefox) or reduced
 *    motion: the static version of the same — alternating two columns on
 *    desktop, stacked on phones.
 *
 * One rest position per scene: copy fully in, stage settled, video
 * playing. The visitor's own scroll drives the transitions between rests;
 * on the pinned layout `useTourScroll` smooths wheel/trackpad input
 * (Lenis, loaded after idle) and settles the page on a rest once the
 * input stops. Elsewhere CSS `proximity` snapping does that.
 *
 * JS: lazy-mounts the pinned stage's far-away scenes (otherwise every
 * poster would load at once), scrolls the pinned layout (`useTourScroll`),
 * sets the colour phase (`useTourTone`, every engine — the colours
 * transition in CSS), and, in `TourVisual`, plays the video of the scene
 * on stage and fans the share scene's PDF pages out once it has settled.
 */
// `warm`: the pointer is over / focus is on a "Start writing" button —
// the page may fetch the new-document dialog's code (useNewDocDialog).
const emit = defineEmits<{ start: [], warm: [] }>()
const { t, locale } = useI18n()

const manifest = await useTourManifest()
const hero = manifest.scenes.find(s => s.id === 'hero')
const scenes = manifest.scenes.filter(s => s.id !== 'hero' && s.id !== 'cta')
const viewportRatio = `${manifest.viewport.w} / ${manifest.viewport.h}`

const INLINE_SIZES = '(max-width: 1023px) 92vw, 58vw'
const STAGE_SIZES = '(min-width: 1440px) 900px, 62vw'
const HERO_SIZES = '(max-width: 639px) calc(100vw - 32px), min(1120px, 92vw)'

// The light → dark flip (see the stylesheet): scenes before TOUR_DARK_FROM
// show their light media, the flip scene both (cross-faded), later ones dark.
const flipIndex = Math.max(0, scenes.findIndex(s => s.id === TOUR_DARK_FROM))
function toneFor(i: number): 'light' | 'dark' | 'flip' {
  if (i < flipIndex) return 'light'
  return i === flipIndex ? 'flip' : 'dark'
}
function sectionStyle(i: number): Record<string, string> {
  return { viewTimelineName: `--mk-s-${i}` }
}

const sceneLabel = (scene: TourScene) => t(`tour.scenes.${scene.id}.label`)
const sceneTitle = (scene: TourScene) => t(`tour.scenes.${scene.id}.title`)
const sceneBody = (scene: TourScene) => t(`tour.scenes.${scene.id}.body`)
const ordinal = (i: number) => String(i + 1).padStart(2, '0')

// One crossing = the scroll from one scene's rest (t = 0.5) to the
// next one's (t = 0.5 of the next scene, 160vh further). Its motion is
// spread over nearly the whole crossing, so any scroll shows movement from
// its first pixels instead of scrolling under pinned content and then
// changing everything at the boundary in a fraction of a second:
//   t 0.53 → 0.85   the outgoing copy fades and lifts out
//   ±SIDE_GLIDE_VH  the stage slides to the other side (around t = 1 / 0)
//   t ±0.125        the stage layers cross-fade (around the boundary)
//   t 0.15 → 0.47   the incoming copy fades in, line after line
// The copy is gone (t 0.85 … 1.15) while the stage passes the middle.
const SIDE_GLIDE_VH = 36
const LINE_IN = 0.15
const LINE_OUT = 0.85
const LINE_STAGGER = 0.015
const LAYER_FADE_T = 0.125
// Scroll-snap rest point of every scene: the middle of its window — copy
// fully in, stage settled, and between the colour flip's ends.
const SNAP_REST_T = 0.5

/** Stage layer i: cross-fade around the scene's window edges (t = ±LAYER_FADE_T, see `mk-fade-window`). */
function layerStyle(i: number): Record<string, string> {
  return { animationTimeline: `--mk-s-${i}`, animationRange: coverRange(-LAYER_FADE_T, 1 + LAYER_FADE_T) }
}
/**
 * Copy line k of scene i on the pinned layout: in before the rest, out
 * right after it (see `mk-line`). Custom properties because the stacked
 * layout drives the same lines with `view()` instead.
 */
function lineVars(i: number, k: number): Record<string, string> {
  return { '--mk-tl': `--mk-s-${i}`, '--mk-range': coverRange(LINE_IN + LINE_STAGGER * k, LINE_OUT) }
}

// timeline-scope lifts every scene's named view timeline to the track,
// so the sticky stage (a sibling, not a descendant) can use them; the
// track's own view timeline drives the side switches and the hand-off.
const trackStyle = {
  'timelineScope': scenes.map((_, i) => `--mk-s-${i}`).join(', '),
  'viewTimelineName': '--mk-track',
  '--mk-rest': `${restOffsetVh(SNAP_REST_T)}vh`
}
useHead({
  style: [{ key: 'mk-tour-sides', textContent: stageSideKeyframes('mk-sides', scenes.length, 'var(--mk-flip)', { glideVh: SIDE_GLIDE_VH }) }]
})

// SSR renders the first scene's layer; the rest mount when their section
// comes within ~1.5 viewports (and stay mounted).
const sectionEls = ref<Array<HTMLElement | null>>([])
const nearScenes = ref<Set<number>>(new Set([0]))
function setSectionEl(i: number, el: Element | ComponentPublicInstance | null): void {
  sectionEls.value[i] = el instanceof HTMLElement ? el : null
}

let observer: IntersectionObserver | null = null
// Same conditions as the stylesheet's pinned layout: anywhere else the
// stage is display:none and must not fetch anything.
const PINNED_QUERY = '(min-width: 1024px) and (prefers-reduced-motion: no-preference)'
const pinnedNow = () => typeof CSS !== 'undefined' && CSS.supports('animation-timeline: view()') && window.matchMedia(PINNED_QUERY).matches

// Rest positions: the page top (hero), each scene's snap marker, the page
// end (closing call to action + footer).
function rests(): number[] {
  const out = [0]
  for (const el of sectionEls.value) {
    const marker = el?.querySelector('.mk-snap--scene')
    if (marker) out.push(Math.round(marker.getBoundingClientRect().top + window.scrollY))
  }
  out.push(Math.max(0, document.documentElement.scrollHeight - window.innerHeight))
  return out
}
const tourScroll = useTourScroll({ rests, active: pinnedNow, activeQuery: PINNED_QUERY })

// A quiet down arrow under the hero and every scene but the last: the
// visible hint that the page goes on, and a way to page with a click or
// Enter/Space. Pinned layout: a smooth scroll to the next rest (rest 0 is
// the hero, rest k the k-th scene). Elsewhere: the next scene section
// scrolls to the middle of the viewport (its snap point), smoothly unless
// the visitor prefers reduced motion.
function goToScene(i: number): void {
  if (pinnedNow()) {
    tourScroll.goTo(i + 1)
    return
  }
  const el = sectionEls.value[i]
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
}
const nextLabel = (i: number): string => {
  const next = scenes[i + 1]
  return next ? t('tour.nextScene', { scene: sceneLabel(next) }) : ''
}

// Dark once the flip scene's top has passed the middle of the viewport —
// between that scene's rest and the previous one's. The colours themselves
// transition in CSS (registered custom properties), so this works without
// scroll-driven animations too.
const { dark } = useTourTone()
let toneRaf = 0
function updateTone(): void {
  toneRaf = 0
  const el = sectionEls.value[flipIndex]
  if (el) dark.value = el.getBoundingClientRect().top < window.innerHeight / 2
}
function queueTone(): void {
  if (!toneRaf) toneRaf = requestAnimationFrame(updateTone)
}

onMounted(() => {
  updateTone()
  window.addEventListener('scroll', queueTone, { passive: true })
  window.addEventListener('resize', queueTone)
  if (!pinnedNow()) return
  observer = new IntersectionObserver((entries) => {
    let changed = false
    const next = new Set(nearScenes.value)
    for (const e of entries) {
      const i = Number(e.target.getAttribute('data-scene-index'))
      if (e.isIntersecting && !next.has(i)) {
        next.add(i)
        changed = true
      }
    }
    if (changed) nearScenes.value = next
  }, { rootMargin: '150% 0px 150% 0px' })
  for (const el of sectionEls.value) if (el) observer.observe(el)
  tourScroll.start()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  tourScroll.stop()
  window.removeEventListener('scroll', queueTone)
  window.removeEventListener('resize', queueTone)
  cancelAnimationFrame(toneRaf)
  dark.value = false
})

const chips = [
  { key: 'byok', icon: 'i-lucide-key-round' },
  { key: 'eu', icon: 'i-lucide-map-pin' },
  { key: 'oss', icon: 'i-lucide-code-xml' }
] as const
</script>

<template>
  <div
    class="mk-tour"
    :lang="locale"
    data-testid="product-tour"
  >
    <div
      class="mk-track"
      :style="trackStyle"
    >
      <!-- 0 · Hero -->
      <section class="mk-hero">
        <div class="mk-hero__copy">
          <i18n-t
            keypath="tour.hero.title"
            tag="h1"
            class="mk-hero__title"
            scope="global"
          >
            <template #markdown>
              <em>{{ t('tour.hero.markdown') }}</em>
            </template>
          </i18n-t>
          <p class="mk-hero__body">
            {{ t('tour.hero.body') }}
          </p>
          <div class="mk-hero__actions">
            <UButton
              size="xl"
              color="neutral"
              icon="i-lucide-pen-line"
              class="mk-cta"
              data-testid="tour-start-writing"
              @click="emit('start')"
              @pointerenter="emit('warm')"
              @focus="emit('warm')"
            >
              {{ t('tour.hero.cta') }}
            </UButton>
            <button
              type="button"
              class="mk-hero__scroll"
              data-testid="tour-next-hero"
              @click="goToScene(0)"
            >
              {{ t('tour.hero.next') }}
              <UIcon
                name="i-lucide-arrow-down"
                class="mk-next__icon"
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
        <!-- The stacked / static layouts' hero picture. The pinned layout
             hides it: there the stage window plays this part. -->
        <figure
          v-if="hero"
          class="mk-hero__figure"
        >
          <LandingTourFrame :ratio="viewportRatio">
            <LandingTourVisual
              :scene="hero"
              :index="-1"
              mode="inline"
              :sizes="HERO_SIZES"
              priority="eager"
            />
          </LandingTourFrame>
        </figure>
      </section>

      <!-- The pinned stage (desktop with scroll-driven animations only). -->
      <div
        class="mk-stage"
        aria-hidden="true"
      >
        <div class="mk-stage__window">
          <div class="mk-stage__slide">
            <LandingTourFrame :ratio="viewportRatio">
              <div
                v-for="(scene, i) in scenes"
                :key="scene.id"
                class="mk-stage__layer"
                :class="{ 'is-first': i === 0, 'is-last': i === scenes.length - 1 }"
                :style="layerStyle(i)"
              >
                <LandingTourVisual
                  :scene="scene"
                  :index="i"
                  :tone="toneFor(i)"
                  mode="stage"
                  :load="nearScenes.has(i)"
                  :sizes="STAGE_SIZES"
                  :section="sectionEls[i] ?? null"
                />
              </div>
              <div
                v-if="hero"
                class="mk-stage__hero"
              >
                <LandingTourVisual
                  :scene="hero"
                  :index="-1"
                  mode="hero"
                  :sizes="STAGE_SIZES"
                  priority="high"
                />
              </div>
            </LandingTourFrame>
          </div>
        </div>
      </div>

      <!-- 1–9 · Scenes -->
      <div
        class="mk-scenes"
        role="region"
        :aria-label="t('tour.label')"
      >
        <section
          v-for="(scene, i) in scenes"
          :key="scene.id"
          :ref="(el) => setSectionEl(i, el)"
          class="mk-scene"
          :class="i % 2 === 0 ? 'mk-scene--odd' : 'mk-scene--even'"
          :data-scene="scene.id"
          :data-scene-index="i"
          :style="sectionStyle(i)"
        >
          <span
            class="mk-snap mk-snap--scene"
            aria-hidden="true"
          />
          <div class="mk-scene__copy">
            <p
              class="mk-line mk-eyebrow"
              :style="lineVars(i, 0)"
            >
              <span>{{ ordinal(i) }}</span> · {{ sceneLabel(scene) }}
            </p>
            <h2
              class="mk-line mk-scene__title"
              :style="lineVars(i, 1)"
            >
              {{ sceneTitle(scene) }}
            </h2>
            <ul
              v-if="scene.id === 'yours'"
              class="mk-line mk-chips"
              :style="lineVars(i, 2)"
            >
              <li
                v-for="chip in chips"
                :key="chip.key"
                class="mk-chip"
              >
                <UIcon
                  :name="chip.icon"
                  class="size-4 shrink-0"
                />
                {{ t(`tour.chips.${chip.key}`) }}
              </li>
            </ul>
            <p
              v-else
              class="mk-line mk-scene__body"
              :style="lineVars(i, 2)"
            >
              {{ sceneBody(scene) }}
            </p>
            <!-- Pinned layout: the next button rides with the copy. -->
            <div
              v-if="i < scenes.length - 1"
              class="mk-line mk-next mk-next--pinned"
              :style="lineVars(i, 3)"
            >
              <button
                type="button"
                class="mk-next__button"
                :aria-label="nextLabel(i)"
                :title="nextLabel(i)"
                :data-testid="`tour-next-${i}`"
                @click="goToScene(i + 1)"
              >
                <UIcon
                  name="i-lucide-arrow-down"
                  class="mk-next__icon"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
          <figure
            v-if="scene.poster"
            class="mk-scene__figure"
            :style="{ viewTimelineName: `--mk-f-${i}` }"
          >
            <LandingTourFrame :ratio="viewportRatio">
              <!-- Hydrates when it comes into view (its job — playing the
                   video while on screen — starts there anyway); the
                   server render is the poster. Keeps the scenes out of
                   the page's first hydration task. -->
              <LazyLandingTourVisual
                hydrate-on-visible
                :scene="scene"
                :index="i"
                :tone="toneFor(i)"
                mode="inline"
                :sizes="INLINE_SIZES"
              />
            </LandingTourFrame>
          </figure>
          <!-- Static layouts: under the picture. -->
          <div
            v-if="i < scenes.length - 1"
            class="mk-next mk-next--static"
          >
            <button
              type="button"
              class="mk-next__button"
              :aria-label="nextLabel(i)"
              :title="nextLabel(i)"
              @click="goToScene(i + 1)"
            >
              <UIcon
                name="i-lucide-arrow-down"
                class="mk-next__icon"
                aria-hidden="true"
              />
            </button>
          </div>
        </section>
      </div>
    </div>

    <!-- 10 · Closing call to action -->
    <section class="mk-final">
      <h2 class="mk-final__title">
        {{ t('tour.cta.title') }}
      </h2>
      <p class="mk-final__body">
        {{ t('tour.cta.body') }}
      </p>
      <div class="mk-final__actions">
        <UButton
          size="xl"
          color="neutral"
          icon="i-lucide-pen-line"
          class="mk-cta"
          data-testid="tour-final-start"
          @click="emit('start')"
          @pointerenter="emit('warm')"
          @focus="emit('warm')"
        >
          {{ t('tour.cta.start') }}
        </UButton>
        <UButton
          size="xl"
          color="neutral"
          variant="outline"
          icon="i-lucide-server"
          class="mk-cta"
          to="/docs/getting-started/self-hosting"
          data-testid="tour-self-host"
        >
          {{ t('tour.cta.selfHost') }}
        </UButton>
      </div>
    </section>
  </div>
</template>

<style>
/* ─── Product tour ─────────────────────────────────────────────────────
   Base = the static layout every browser gets (and the reduced-motion
   layout): no movement. The scroll-driven choreography is layered on at
   the bottom inside @supports (animation-timeline: view()) +
   prefers-reduced-motion: no-preference.

   --mk-consent-h is the cookie bar's height while it is open (set by
   ConsentBanner.vue): the pinned stage and copy centre in the space
   above it, and the closing buttons always scroll clear of it. */

/* ─── Colours: the light → dark flip ───────────────────────────────
   The tour's colours are registered custom properties, so they can
   transition. `.mk-tour-page` is the home page's root while the tour is
   shown (app/pages/index.vue), so the header turns with the page:

   - `--auto` (no choice made on this visit): starts LIGHT whatever the OS
     prefers; `is-dark` (set by ProductTour from the scroll position, every
     engine) turns the whole page dark once the flip scene
     (TOUR_DARK_FROM, shared/tour/config.ts) has come in, light again on
     the way back — a ~0.7 s transition, instant with reduced motion. The
     scene media follow (`data-tone` on each visual; the flip scene
     cross-fades its two videos with `--mk-dark`).
   - `--light` / `--dark` (picked with the page's header toggle during
     this visit): that mode throughout, no flip; `.dark` on <html> picks
     the media.

   Nuxt UI's surface variables are mapped onto the same tokens inside the
   page, so the header's buttons turn too. The cookie bar (teleported to
   <body>) keeps the app's own colours: legible in both phases. Text
   pairs meet WCAG AA in both: ink/bg ≥ 15:1, soft ink ≥ 6:1, muted
   (eyebrows) ≥ 5:1. */
@property --mk-bg { syntax: '<color>'; inherits: true; initial-value: #FAF8F4; }
@property --mk-card { syntax: '<color>'; inherits: true; initial-value: #FFFFFF; }
@property --mk-raised { syntax: '<color>'; inherits: true; initial-value: #F2EFE7; }
@property --mk-ink { syntax: '<color>'; inherits: true; initial-value: #14110D; }
@property --mk-ink-soft { syntax: '<color>'; inherits: true; initial-value: #5F5C56; }
@property --mk-muted { syntax: '<color>'; inherits: true; initial-value: #5F5C56; }
@property --mk-rule { syntax: '<color>'; inherits: true; initial-value: #EAE5D7; }
@property --mk-chip-border { syntax: '<color>'; inherits: true; initial-value: #D5CFC0; }
@property --mk-frame-bar { syntax: '<color>'; inherits: true; initial-value: #F2EFE7; }
@property --mk-frame-dot { syntax: '<color>'; inherits: true; initial-value: #D5CFC0; }
@property --mk-scrim { syntax: '<color>'; inherits: true; initial-value: rgb(242 239 231 / 0.78); }
@property --mk-dark { syntax: '<number>'; inherits: true; initial-value: 0; }

/* `.mk-tour` alone only where it is not inside the page root — inside, it
   must inherit the root's (animated) values, not redeclare static ones. */
.mk-tour-page,
.mk-tour:not(.mk-tour-page *) {
  --mk-bg: var(--color-sumi-50);
  --mk-card: #FFFFFF;
  --mk-raised: var(--color-sumi-100);
  --mk-ink: var(--color-sumi-950);
  --mk-ink-soft: var(--color-sumi-600);
  --mk-muted: var(--color-sumi-600);
  --mk-rule: var(--color-sumi-200);
  --mk-chip-border: var(--color-sumi-300);
  --mk-frame-bar: var(--color-sumi-100);
  --mk-frame-dot: var(--color-sumi-300);
  --mk-scrim: rgb(242 239 231 / 0.78);
  --mk-dark: 0;
}
.mk-tour-page--dark,
.mk-tour-page--auto.is-dark {
  --mk-bg: var(--color-sumi-950);
  --mk-card: var(--color-sumi-900);
  --mk-raised: var(--color-sumi-900);
  --mk-ink: var(--color-sumi-50);
  --mk-ink-soft: var(--color-sumi-400);
  --mk-muted: var(--color-sumi-400);
  --mk-rule: var(--color-sumi-800);
  --mk-chip-border: var(--color-sumi-700);
  --mk-frame-bar: var(--color-sumi-900);
  --mk-frame-dot: var(--color-sumi-700);
  --mk-scrim: rgb(20 17 13 / 0.78);
  --mk-dark: 1;
}
.mk-tour-page--auto {
  transition-property: --mk-bg, --mk-card, --mk-raised, --mk-ink, --mk-ink-soft, --mk-muted, --mk-rule,
    --mk-chip-border, --mk-frame-bar, --mk-frame-dot, --mk-scrim, --mk-dark;
  transition-duration: 700ms;
  transition-timing-function: cubic-bezier(.45, 0, .25, 1);
}
@media (prefers-reduced-motion: reduce) {
  .mk-tour-page--auto { transition: none; }
}
.mk-tour-page {
  background: var(--mk-bg);
  color: var(--mk-ink);
  --ui-bg: var(--mk-card);
  --ui-bg-muted: var(--mk-bg);
  --ui-bg-elevated: var(--mk-raised);
  --ui-bg-accented: var(--mk-raised);
  --ui-bg-inverted: var(--mk-ink);
  --ui-text: var(--mk-ink);
  --ui-text-highlighted: var(--mk-ink);
  --ui-text-toned: var(--mk-ink-soft);
  --ui-text-muted: var(--mk-muted);
  --ui-text-dimmed: var(--mk-muted);
  --ui-text-inverted: var(--mk-bg);
  --ui-border: var(--mk-rule);
  --ui-border-muted: var(--mk-rule);
  --ui-border-accented: var(--mk-chip-border);
  --ui-border-inverted: var(--mk-ink);
}
.mk-tour {
  color: var(--mk-ink);
  overflow-x: clip;
}
/* The wordmark lockup has a light and a dark file: cross-fade them. */
html .mk-tour-page--auto .mk-wordmark__img--light { display: block; opacity: calc(1 - var(--mk-dark)); }
html .mk-tour-page--auto .mk-wordmark__img--dark {
  display: block;
  position: absolute;
  left: 0;
  top: 50%;
  translate: 0 -50%;
  opacity: var(--mk-dark);
}
/* Layout lengths, all plain CSS so the stage's travel can be computed:
   inner = content width, copy = copy column, win = the window's width. */
.mk-track {
  --mk-W: min(100vw, 1480px);
  --mk-pad: clamp(16px, 4vw, 64px);
  --mk-gap: clamp(32px, 4vw, 72px);
  --mk-inner: calc(var(--mk-W) - 2 * var(--mk-pad));
  --mk-copy: max(300px, calc((var(--mk-inner) - var(--mk-gap)) * 0.3));
  --mk-stagecol: calc(var(--mk-inner) - var(--mk-gap) - var(--mk-copy));
  --mk-win: min(var(--mk-stagecol), calc((100vh - 150px - var(--mk-consent-h, 0px)) * 1.6));
  /* Left side = shift by everything the window isn't. */
  --mk-flip: calc(var(--mk-win) - var(--mk-inner));
  position: relative;
  max-width: 1480px;
  margin-inline: auto;
  padding-inline: var(--mk-pad);
}

.mk-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: clamp(40px, 9svh, 112px) 0 clamp(32px, 6svh, 72px);
  text-align: center;
}
.mk-hero__copy {
  max-width: 46rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(18px, 2.6svh, 28px);
}
.mk-hero__title {
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: clamp(40px, 6.4vw, 84px);
  line-height: 1.02;
  letter-spacing: -0.025em;
  text-wrap: balance;
}
.mk-hero__title em {
  font-style: italic;
  font-weight: 400;
}
.mk-hero__body {
  max-width: 34ch;
  font-size: clamp(15px, 1.35vw, 18px);
  line-height: 1.6;
  color: var(--mk-ink-soft);
  text-wrap: pretty;
}
.mk-hero__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px 20px;
  padding-top: 4px;
}
.mk-cta { min-height: 48px; justify-content: center; }
.mk-hero__figure {
  width: min(1120px, 100%);
  margin: clamp(40px, 7svh, 80px) 0 0;
}
/* "See how it works ↓" beside the call to action, and the round arrow
   under every scene but the last: quiet (mono caption, hairline), but a
   real button — a click (or Enter / Space) scrolls to the next scene. */
.mk-hero__scroll {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 6px;
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--mk-muted);
  transition: color 160ms ease;
}
.mk-hero__scroll:hover { color: var(--mk-ink); }
.mk-next__icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.mk-next--pinned { display: none; }
.mk-next--static {
  grid-column: 1 / -1;
  display: flex;
  justify-content: center;
}
.mk-next__button {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--mk-chip-border);
  border-radius: 999px;
  color: var(--mk-muted);
  transition: color 160ms ease, border-color 160ms ease;
}
.mk-next__button:hover {
  color: var(--mk-ink);
  border-color: var(--mk-ink-soft);
}
.mk-hero__scroll:focus-visible,
.mk-next__button:focus-visible {
  outline: 2px solid var(--mk-ink);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: no-preference) {
  /* One small nudge, twice, then still: enough to say "there is more". */
  .mk-hero__scroll .mk-next__icon { animation: mk-nudge 1.6s ease-in-out 1.4s 2; }
}
@keyframes mk-nudge {
  0%, 100% { translate: 0 0; }
  50% { translate: 0 4px; }
}

.mk-visual {
  position: absolute;
  inset: 0;
}
.mk-visual__media {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.mk-visual__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
video.mk-visual__media {
  object-fit: cover;
  /* Shown once frames are actually playing; until then the poster image
     underneath stands in (and stays, with reduced motion). */
  opacity: 0;
  transition: opacity 240ms ease;
}
video.mk-visual__media.is-playing { opacity: 1; }
/* Which colour mode's media shows. Explicit choice: `.dark` on <html>.
   The flip (`--auto`): each visual's tone — the flip scene cross-fades. */
.mk-visual__tone {
  position: absolute;
  inset: 0;
}
.mk-visual__tone--dark { display: none; }
html.dark .mk-visual__tone--light { display: none; }
html.dark .mk-visual__tone--dark { display: block; }
html .mk-tour-page--auto .mk-visual[data-tone="light"] .mk-visual__tone--light { display: block; }
html .mk-tour-page--auto .mk-visual[data-tone="light"] .mk-visual__tone--dark { display: none; }
html .mk-tour-page--auto .mk-visual[data-tone="dark"] .mk-visual__tone--light { display: none; }
html .mk-tour-page--auto .mk-visual[data-tone="dark"] .mk-visual__tone--dark { display: block; }
html .mk-tour-page--auto .mk-visual[data-tone="flip"] .mk-visual__tone { display: block; }
html .mk-tour-page--auto .mk-visual[data-tone="flip"] .mk-visual__tone--dark { opacity: var(--mk-dark); }

/* Fanned PDF pages, part of the share scene's rest state: `is-open`
   (TourVisual, once the scene has settled) fans them out of the window's
   centre over ~1 s, one after another; leaving folds them back. */
.mk-fan {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.mk-fan__scrim {
  position: absolute;
  inset: 0;
  background: var(--mk-scrim);
  opacity: 0;
  transition: opacity 500ms ease;
}
.mk-fan__page {
  grid-area: 1 / 1;
  width: 26%;
  height: auto;
  background: #fff;
  border: 1px solid var(--mk-rule);
  border-radius: 2px;
  /* Paper on a desk: the one place a soft shadow is the object itself. */
  box-shadow: 0 18px 40px -22px rgb(20 17 13 / 0.45);
  transform-origin: 50% 110%;
  opacity: 0;
  translate: 0 12%;
  rotate: 0deg;
  scale: 0.9;
  transition:
    opacity 380ms ease,
    translate 1000ms cubic-bezier(.3, .7, .2, 1),
    rotate 1000ms cubic-bezier(.3, .7, .2, 1),
    scale 1000ms cubic-bezier(.3, .7, .2, 1);
  transition-delay: 0ms;
}
.mk-fan.is-open .mk-fan__scrim { opacity: 1; }
.mk-fan.is-open .mk-fan__page {
  opacity: 1;
  translate: calc(var(--mk-o) * 62%) 0;
  rotate: calc(var(--mk-o) * 7deg);
  scale: 1;
  transition-delay: calc(120ms + var(--mk-k, 0) * 110ms);
}
@media (prefers-reduced-motion: reduce) {
  .mk-fan__scrim,
  .mk-fan__page { transition: none; }
}
@media (max-width: 639px) {
  .mk-fan__page { width: 30%; }
}

.mk-stage { display: none; }
.mk-scene {
  display: grid;
  gap: clamp(20px, 3vw, 32px);
  padding-block: clamp(48px, 9svh, 120px);
}
.mk-scene + .mk-scene { border-top: 1px solid var(--mk-rule); }
/* Stacked: what the scene is about first, then the picture of it. */
.mk-scene__figure { margin: 0; }
.mk-scene__copy {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 34rem;
}
.mk-eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--mk-muted);
}
.mk-eyebrow span { color: var(--mk-ink); }
.mk-scene__title {
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: clamp(30px, 3vw, 46px);
  line-height: 1.06;
  letter-spacing: -0.02em;
  text-wrap: balance;
}
.mk-scene__body {
  font-size: clamp(15px, 1.2vw, 17px);
  line-height: 1.6;
  color: var(--mk-ink-soft);
  max-width: 36ch;
  text-wrap: pretty;
}
.mk-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}
.mk-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid var(--mk-chip-border);
  border-radius: 999px;
  font-size: 14px;
  line-height: 1.3;
  color: var(--mk-ink);
}

@media (min-width: 1024px) {
  /* Static desktop: copy beside its picture, alternating sides. */
  .mk-scene {
    grid-template-columns: var(--mk-copy) minmax(0, 1fr);
    align-items: center;
    column-gap: var(--mk-gap);
  }
  .mk-scene__figure { order: 0; }
  .mk-scene--even { grid-template-columns: minmax(0, 1fr) var(--mk-copy); }
  .mk-scene--even .mk-scene__figure { order: -1; }
}

/* Japanese / Chinese headings: break at phrase boundaries, not inside words. */
:lang(ja) :is(.mk-hero__title, .mk-scene__title, .mk-final__title),
:lang(zh) :is(.mk-hero__title, .mk-scene__title, .mk-final__title) {
  word-break: auto-phrase;
  line-break: strict;
}

/* Phones in landscape: copy beside the picture, so a scene fits the
   short screen. */
@media (min-width: 640px) and (max-width: 1023px) and (max-height: 520px) {
  .mk-scene {
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
    align-items: center;
    column-gap: 28px;
    padding-block: 28px;
  }
  .mk-scene__title { font-size: 26px; }
  .mk-scene__body { font-size: 15px; }
}

.mk-final {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: clamp(80px, 18svh, 200px) clamp(16px, 4vw, 64px) calc(clamp(72px, 14svh, 160px) + var(--mk-consent-h, 0px));
  text-align: center;
}
.mk-final__title {
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: clamp(44px, 7vw, 96px);
  line-height: 1;
  letter-spacing: -0.03em;
}
.mk-final__body {
  font-size: clamp(15px, 1.35vw, 18px);
  line-height: 1.6;
  color: var(--mk-ink-soft);
  max-width: 34ch;
}
.mk-final__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  padding-top: 8px;
}
@media (max-width: 639px) {
  .mk-final__actions { flex-direction: column; align-self: stretch; }
  .mk-hero__actions { align-self: stretch; flex-direction: column; align-items: stretch; }

  /* Phones: every scene is one composed screen above the cookie bar —
     copy, then the phone cut of its video. */
  .mk-hero {
    padding: 36px 0 28px;
    text-align: left;
    align-items: stretch;
  }
  .mk-hero__copy { align-items: flex-start; gap: 18px; }
  .mk-hero__title { font-size: clamp(38px, 11vw, 48px); line-height: 1.04; }
  .mk-hero__body { font-size: 16px; max-width: none; }
  .mk-hero__figure { margin-top: 32px; }
  .mk-hero__scroll { align-self: center; }
  .mk-scene {
    gap: 22px;
    padding-block: 44px 52px;
  }
  .mk-scene__copy { gap: 10px; }
  .mk-scene__title { font-size: clamp(28px, 8.4vw, 34px); line-height: 1.08; }
  .mk-scene__body { font-size: 16px; max-width: none; }
  .mk-chip { min-height: 40px; font-size: 14px; }
  .mk-final {
    padding-top: 72px;
    padding-bottom: calc(56px + var(--mk-consent-h, 0px));
  }
  .mk-final__title { font-size: clamp(36px, 10.5vw, 46px); line-height: 1.05; text-wrap: balance; }
  .mk-final__body { font-size: 16px; }

  /* Header controls: comfortable tap targets. */
  .mk-tour-page > header :is(a, button) { min-height: 44px; min-width: 44px; }
}

/* ─── Time-based entrance of the hero (not scroll-driven) ─── */
@media (prefers-reduced-motion: no-preference) {
  .mk-hero__copy > * { animation: mk-rise 900ms cubic-bezier(.2, .7, .2, 1) both; }
  .mk-hero__copy > :nth-child(2) { animation-delay: 90ms; }
  .mk-hero__copy > :nth-child(3) { animation-delay: 180ms; }
  .mk-hero__figure { animation: mk-rise-window 1200ms 280ms cubic-bezier(.2, .7, .2, 1) both; }
}
@keyframes mk-rise {
  from { opacity: 0; translate: 0 14px; }
}
/* The window rises without fading in: it holds the page's LCP image (the
   hero poster), and a browser counts an element as painted only once it
   is no longer transparent — a fade from opacity 0 made the picture
   "appear" at the end of a busy main thread. */
@keyframes mk-rise-window {
  from { translate: 0 40px; scale: 0.97; }
}

/* ─── Scroll snapping (the tour page only) ──────────────────────────
   One rest position per scene: copy fully in, stage settled, video
   playing. Every transition (stage glide, copy fades, the colour flip)
   lies between two rest positions. Rest points are 1px markers
   (`.mk-snap`), not the sections: a snap area taller than the viewport
   lets the browser stop anywhere inside it.
   - Pinned desktop layout: proximity snapping on the 1px markers until
     Lenis has loaded (useTourScroll); then CSS snapping is off (Lenis
     sets the scroll position every frame, which native snapping would
     fight) and useTourScroll settles the page on the rests itself.
   - Everything else (phones, tablets, Firefox, reduced motion): gentle
     proximity snapping on the scene sections, no Lenis.
   The hero rest is the page top (the page's header, the first thing in
   the document — a marker above the page would be clamped to 0 by
   Chromium but dropped by WebKit); the last rest is the page bottom
   (footer end, or the closing section's end without a footer), so
   nothing is unreachable. */
html:has(.mk-tour-page) {
  /* The root background is the overscroll colour (main.css: ink in
     light mode, shu in dark); the page root paints the tour's phase. */
  scroll-snap-type: y proximity;
  scroll-padding-bottom: var(--mk-consent-h, 0px);
}
@media (prefers-reduced-motion: reduce) {
  html:has(.mk-tour-page) { scroll-behavior: auto; }
}
/* Lenis (pinned layout only, see useTourScroll) — the rules of its
   lenis.css that apply here. */
html.lenis,
html.lenis body { height: auto; }
.lenis [data-lenis-prevent] { overscroll-behavior: contain; }
.lenis.lenis-smooth iframe { pointer-events: none; }
.mk-snap {
  position: absolute;
  left: 0;
  width: 1px;
  height: 1px;
  pointer-events: none;
  scroll-snap-align: start;
  scroll-snap-stop: always;
}
.mk-tour-page > header:first-child {
  scroll-snap-align: start;
  scroll-snap-stop: always;
}
.mk-snap--scene { display: none; }
.mk-scene { scroll-snap-align: center; }
.mk-tour-page > .legal-footer,
.mk-tour-page:not(:has(> .legal-footer)) .mk-final {
  scroll-snap-align: end;
  scroll-snap-stop: always;
}

@keyframes mk-fade-window {
  /* Spans window t = -0.125 … 1.125 (LAYER_FADE_T): fade in over the first
     0.25, out over the last 0.25 — centred on the scene boundaries. */
  0% { opacity: 0; }
  20%, 80% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes mk-fade-out-only {
  0%, 80% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes mk-fade-in-only {
  0% { opacity: 0; }
  20%, 100% { opacity: 1; }
}
@keyframes mk-line {
  /* Range t = LINE_IN (+ stagger) … LINE_OUT of the scene window (see
     lineVars): fully in just before the rest (t = 0.5), leaving right
     after it, so the copy moves through most of every crossing. */
  0% { opacity: 0; translate: 0 22px; }
  42%, 55% { opacity: 1; translate: 0 0; }
  100% { opacity: 0; translate: 0 -18px; }
}
@keyframes mk-reveal {
  from { opacity: 0; translate: 0 48px; scale: 0.96; }
  to { opacity: 1; translate: 0 0; scale: 1; }
}
@keyframes mk-stage-out {
  to { opacity: 0; translate: 0 -24px; scale: 0.97; }
}
@keyframes mk-hero-travel {
  /* From centred under the hero copy to the stage's right side. */
  /* Low enough that its top clears the hero's button. */
  from { transform: translate(calc((var(--mk-win) - var(--mk-inner)) / 2), 50vh) scale(1.08); }
  to { transform: none; }
}
@keyframes mk-hero-layer-out {
  to { opacity: 0; }
}

@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    /* Phones + tablets: each figure reveals on its own timeline. */
    .mk-scene__figure {
      animation: mk-reveal linear both;
      animation-timeline: view();
      animation-range: entry 0% entry 70%;
    }
    .mk-scene__copy > * {
      animation: mk-reveal linear both;
      animation-timeline: view();
      animation-range: entry 10% entry 90%;
    }

    @media (min-width: 1024px) {
      /* One track: hero, then the scenes; the stage spans both, pinned. */
      .mk-track {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
      }
      .mk-hero {
        grid-row: 1;
        grid-column: 1;
        height: 100vh;
        justify-content: flex-start;
        position: relative;
        z-index: 1;
      }
      .mk-hero__figure { display: none; }
      .mk-scenes {
        grid-row: 2;
        grid-column: 1;
        position: relative;
        z-index: 1;
      }
      .mk-stage {
        display: flex;
        grid-row: 1 / span 2;
        grid-column: 1;
        position: sticky;
        top: 0;
        height: calc(100vh - var(--mk-consent-h, 0px));
        align-items: center;
        justify-content: flex-end;
        pointer-events: none;
      }
      .mk-stage__window {
        width: var(--mk-win);
        /* Leaving the hero carries the window to its place; at the end of
           the track it leaves before the closing section. */
        animation: mk-hero-travel linear both, mk-stage-out linear both;
        animation-timeline: scroll(root), --mk-track;
        animation-range: 0 75vh, exit 0% exit 18%;
      }
      .mk-stage__slide {
        animation: mk-sides linear both;
        animation-timeline: --mk-track;
        animation-range: cover 0% cover 100%;
      }
      .mk-stage__layer {
        position: absolute;
        inset: 0;
        animation: mk-fade-window linear both;
      }
      .mk-stage__layer.is-first { animation-name: mk-fade-out-only; }
      .mk-stage__layer.is-last { animation-name: mk-fade-in-only; }
      .mk-stage__hero {
        position: absolute;
        inset: 0;
        animation: mk-hero-layer-out linear both;
        animation-timeline: scroll(root);
        animation-range: 55vh 85vh;
      }

      .mk-scene {
        display: block;
        position: relative;
        height: 160vh;
        padding: 0;
        scroll-snap-align: none;
      }
      html.lenis:has(.mk-tour-page) { scroll-snap-type: none; }
      /* The rest point: the scene's window at t = SNAP_REST_T (script),
         where the marker's top meets the viewport top. */
      .mk-snap--scene {
        display: block;
        top: var(--mk-rest);
      }
      .mk-scene + .mk-scene { border-top: 0; }
      .mk-scene__figure { display: none; }
      .mk-scene__copy {
        position: sticky;
        top: calc((100vh - var(--mk-consent-h, 0px)) / 2);
        translate: 0 -50%;
        width: var(--mk-copy);
      }
      .mk-scene--even .mk-scene__copy { margin-left: auto; }
      .mk-next--static { display: none; }
      .mk-next--pinned { display: flex; padding-top: 10px; }
      .mk-scene__copy > .mk-line {
        animation: mk-line linear both;
        animation-timeline: var(--mk-tl);
        animation-range: var(--mk-range);
      }
    }
  }
}
</style>
