<script setup lang="ts">
import { coverRange, restOffsetVh, stageSideKeyframes, type TourScene } from '~~/shared/tour/manifest'
import { TOUR_DARK_FROM } from '~~/shared/tour/config'

/**
 * markoto.app's product page: shown at `/` to logged-out visitors
 * when the instance enables it (`NUXT_MARKETING_SITE_ENABLED`, see
 * `shared/config/instance.ts`). Hero → nine scenes → closing CTA. Each
 * scene's picture is a short looping video recorded from the real app.
 *
 * CSS does the choreography (`assets/css/productTour.css`):
 *  - Desktop (≥ 1024px) with scroll-driven animations and no
 *    reduced-motion preference: ONE browser window. Under the hero it sits
 *    centred; scrolling out of the hero carries it (transforms on a
 *    `scroll()` timeline) to the sticky stage, where it becomes scene 1.
 *    From there it alternates sides, odd scenes right, even scenes left,
 *    sliding across while one scene's copy fades out and the next one's
 *    fades in on the free side (generated keyframes on the track's view
 *    timeline, `stageSideKeyframes`). Every scene section names a view
 *    timeline (`--mk-s-<i>`, lifted to the track by `timeline-scope`)
 *    that cross-fades the stage layers and the copy. At the end the window
 *    leaves before the closing section.
 *  - Phones / tablets: each scene is one screen, its copy, then its own
 *    window (the phone cut of the video).
 *  - No scroll-driven animations (older Safari / Firefox) or reduced
 *    motion: the static version of the same, alternating two columns on
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
 * sets the colour phase (`useTourTone`, every engine, the colours
 * transition in CSS), and, in `TourVisual`, plays the video of the scene
 * on stage and fans the share scene's PDF pages out once it has settled.
 */
// `warm`: the pointer is over / focus is on a "Start writing" button,
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
// Scroll-snap rest point of every scene: the middle of its window, copy
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

// Dark once the flip scene's top has passed the middle of the viewport,
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

// Where the stage window rests under the hero. The stylesheet's default
// (half a viewport down) assumes the hero copy ends above that line; the
// copy's height follows the viewport WIDTH, so on a wide but short window
// it does not, and the window would cover the call-to-action button. Push
// it down just far enough to clear the copy.
const HERO_WINDOW_GAP_PX = 28
const HERO_WINDOW_SCALE = 1.08
const trackEl = ref<HTMLElement | null>(null)
const heroCopyEl = ref<HTMLElement | null>(null)
const stageEl = ref<HTMLElement | null>(null)
const stageWindowEl = ref<HTMLElement | null>(null)
const heroWindowY = ref<string | undefined>(undefined)
function placeHeroWindow(): void {
  const [track, copy, stage, win] = [trackEl.value, heroCopyEl.value, stageEl.value, stageWindowEl.value]
  if (!track || !copy || !stage || !win || !pinnedNow()) {
    heroWindowY.value = undefined
    return
  }
  const copyBottom = copy.getBoundingClientRect().bottom - track.getBoundingClientRect().top
  // Untransformed: centred in the stage. The hero pose scales it around its
  // centre, which lifts its top edge by half the growth.
  const centredTop = (stage.offsetHeight - win.offsetHeight) / 2
  const lift = win.offsetHeight * (HERO_WINDOW_SCALE - 1) / 2
  const needed = copyBottom + HERO_WINDOW_GAP_PX - centredTop + lift
  heroWindowY.value = `${Math.round(Math.max(window.innerHeight / 2, needed))}px`
}
useResizeObserver([heroCopyEl, stageEl, stageWindowEl], placeHeroWindow)
onMounted(placeHeroWindow)

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
    :style="{ '--mk-hero-y': heroWindowY }"
    data-testid="product-tour"
  >
    <div
      ref="trackEl"
      class="mk-track"
      :style="trackStyle"
    >
      <!-- 0 · Hero -->
      <section class="mk-hero">
        <div
          ref="heroCopyEl"
          class="mk-hero__copy"
        >
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
            {{ t('landing.subtitle') }}
          </p>
          <div class="mk-hero__actions">
            <UButton
              size="xl"
              color="neutral"
              icon="i-lucide-pen-line"
              class="mk-cta"
              data-testid="tour-start-writing"
              data-early-click
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
        ref="stageEl"
        class="mk-stage"
        aria-hidden="true"
      >
        <div
          ref="stageWindowEl"
          class="mk-stage__window"
        >
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
              <!-- Hydrates when it comes into view (its job, playing the
                   video while on screen, starts there anyway); the
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
          data-early-click
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
          to="/docs/self-hosting"
          data-testid="tour-self-host"
        >
          {{ t('tour.cta.selfHost') }}
        </UButton>
      </div>
    </section>
  </div>
</template>

<!-- The tour's page stylesheet (global: it also styles `.mk-tour-page`, the
     home page's root, and the header inside it). -->
<style src="../../assets/css/productTour.css"></style>
