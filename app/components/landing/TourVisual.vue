<script setup lang="ts">
import {
  srcsetFor,
  VIDEO_TYPES,
  type TourBeat,
  type TourScene
} from '~~/shared/tour/manifest'
import { TOUR_DEPART_EVENT, TOUR_REST_EVENT, tourEventIndex } from '~/composables/useTourPager'

/**
 * One scene's picture: a poster still and a short looping video, each in
 * light + dark (both rendered, CSS-toggled — the Wordmark pattern, so SSR
 * and client agree and the hidden mode never downloads) and, inline on
 * phones, the scene's phone cut (`<source media>`). The cursor is baked
 * into the video by the capture.
 *
 * JS: play the visible video while the scene is on stage and pause it
 * otherwise (videos are `preload="none"`, so nothing downloads before;
 * reduced motion → the poster only), and fan the share scene's PDF pages
 * out once the scene has settled.
 *
 * Modes:
 *  - `stage`  — a layer of the pinned desktop stage; "on stage" = the
 *               scene's section crosses the middle of the viewport.
 *  - `inline` — the figure inside the scene section (phones, tablets and
 *               browsers without scroll-driven animations); "on stage" =
 *               the figure is mostly in view.
 *  - `hero`   — poster only.
 */
const props = withDefaults(defineProps<{
  scene: TourScene
  index: number
  mode: 'stage' | 'inline' | 'hero'
  /** Render the media (the stage defers far-away scenes). */
  load?: boolean
  /** `sizes` attribute for the poster. */
  sizes: string
  /** The scene's section element (stage mode). */
  section?: HTMLElement | null
  /**
   * Which color mode's media this scene shows while the page runs its
   * light → dark scroll flip (see ProductTour.vue): `flip` = the scene the
   * page turns dark on (both, cross-faded). Ignored when the visitor
   * picked a color mode — then `.dark` on <html> decides.
   */
  tone?: 'light' | 'dark' | 'flip'
}>(), {
  load: true,
  section: null,
  tone: 'light'
})

const { t } = useI18n()
const alt = computed(() => t(`tour.alt.${props.scene.id}`))
const beatAlt = (beat: TourBeat) => t(`tour.alt.${beat.id}`)
const modes = ['light', 'dark'] as const
type Mode = typeof modes[number]

const pageBeats = computed(() => (props.mode === 'hero' ? [] : props.scene.beats ?? []))
function pageVars(beat: TourBeat, i: number): Record<string, string | number> {
  const o = i - (beat.pages.length - 1) / 2
  // The middle page lies on top; `--mk-k` staggers the pages' entrance.
  return { '--mk-o': o, '--mk-k': i, 'zIndex': String(10 - Math.round(Math.abs(o) * 2)) }
}

// ─── PDF fan-out (the share scene's beat) ─────────────────────────────
// Time-based, part of the scene's REST state: once the scene has settled
// (pinned stage: the pager's rest event; inline: the figure mostly in
// view), the pages fan out over the window; they fold back as soon as the
// page moves on. The delay lets the share dialog in the video be seen
// first. Reduced motion: shown fanned, no movement.
const FAN_DELAY_MS = 1600
const fanOpen = ref(false)
let fanTimer: ReturnType<typeof setTimeout> | undefined
let fanObserver: IntersectionObserver | null = null
function setFan(open: boolean, delay = 0): void {
  clearTimeout(fanTimer)
  if (!open) {
    fanOpen.value = false
    return
  }
  fanTimer = setTimeout(() => {
    fanOpen.value = true
  }, delay)
}
function onRest(e: Event): void {
  setFan(tourEventIndex(e) === props.index + 1, FAN_DELAY_MS)
}
function onDepart(): void {
  setFan(false)
}
function startFan(): void {
  if (pageBeats.value.length === 0) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    fanOpen.value = true
    return
  }
  if (props.mode === 'stage') {
    window.addEventListener(TOUR_REST_EVENT, onRest)
    window.addEventListener(TOUR_DEPART_EVENT, onDepart)
    return
  }
  if (!root.value) return
  fanObserver = new IntersectionObserver((entries) => {
    for (const e of entries) setFan(e.isIntersecting, FAN_DELAY_MS - 400)
  }, { threshold: 0.6 })
  fanObserver.observe(root.value)
}

const hasVideo = computed(() => props.mode !== 'hero' && Boolean(props.scene.video))
const phoneVideo = computed(() => (props.mode === 'inline' ? props.scene.phone?.video : undefined))
const phonePoster = computed(() => (props.mode === 'inline' ? props.scene.phone?.poster : undefined))

// ─── Playback ─────────────────────────────────────────────────────────
const root = ref<HTMLElement | null>(null)
const videoEls: Record<Mode, HTMLVideoElement | null> = { light: null, dark: null }
const playing = ref<Record<Mode, boolean>>({ light: false, dark: false })
function setVideo(m: Mode, el: Element | ComponentPublicInstance | null): void {
  videoEls[m] = el instanceof HTMLVideoElement ? el : null
}
let observer: IntersectionObserver | null = null
let onStage = false
let reducedMotion = false
const colorMode = useColorMode()

function sync(): void {
  for (const m of modes) {
    const v = videoEls[m]
    if (!v) continue
    // Only the color mode on screen plays (the other is display:none).
    const shown = v.offsetParent !== null
    if (onStage && shown && !reducedMotion) {
      if (v.paused) v.play().catch(() => { /* autoplay refused: the poster stays */ })
    } else if (!v.paused) {
      v.pause()
    }
  }
}

onMounted(() => {
  startFan()
  if (!hasVideo.value) return
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reducedMotion) return
  const stage = props.mode === 'stage'
  const start = (target: Element) => {
    observer?.disconnect()
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) onStage = e.isIntersecting
      sync()
    }, stage ? { rootMargin: '-35% 0px -35% 0px' } : { threshold: 0.4 })
    observer.observe(target)
  }
  if (stage) {
    // The section's template ref can arrive after this component mounted.
    watch(() => props.section, (s) => {
      if (s) start(s)
    }, { immediate: true })
  } else if (root.value) {
    start(root.value)
  }
})
watch(() => colorMode.value, () => nextTick(sync))
onBeforeUnmount(() => {
  observer?.disconnect()
  fanObserver?.disconnect()
  clearTimeout(fanTimer)
  window.removeEventListener(TOUR_REST_EVENT, onRest)
  window.removeEventListener(TOUR_DEPART_EVENT, onDepart)
  for (const m of modes) videoEls[m]?.pause()
})
</script>

<template>
  <div
    ref="root"
    class="mk-visual"
    :class="`mk-visual--${mode}`"
    :data-tone="tone"
  >
    <template v-if="load && scene.poster">
      <!-- One container per color mode: the poster (`loading` before
           `src`: an <img> created on the client starts fetching the
           moment `src` is set) and the video above it. -->
      <div
        v-for="m in modes"
        :key="m"
        class="mk-visual__tone"
        :class="`mk-visual__tone--${m}`"
      >
        <picture class="mk-visual__media">
          <source
            v-if="phonePoster"
            media="(max-width: 639px)"
            sizes="calc(100vw - 32px)"
            :srcset="srcsetFor(phonePoster[m])"
          >
          <img
            loading="lazy"
            decoding="async"
            class="mk-visual__img"
            :sizes="sizes"
            :srcset="srcsetFor(scene.poster[m])"
            :src="scene.poster[m].src"
            :width="scene.poster[m].width"
            :height="scene.poster[m].height"
            :alt="alt"
          >
        </picture>
        <video
          v-if="hasVideo && scene.video"
          :ref="(el) => setVideo(m, el)"
          class="mk-visual__media mk-video"
          :class="{ 'is-playing': playing[m] }"
          muted
          loop
          playsinline
          disablepictureinpicture
          preload="none"
          aria-hidden="true"
          tabindex="-1"
          @playing="playing[m] = true"
        >
          <template v-if="phoneVideo">
            <source
              v-if="phoneVideo[m].av1"
              media="(max-width: 639px)"
              :src="phoneVideo[m].av1"
              :type="VIDEO_TYPES.av1"
            >
            <source
              media="(max-width: 639px)"
              :src="phoneVideo[m].h264"
              :type="VIDEO_TYPES.h264"
            >
          </template>
          <source
            v-if="scene.video[m].av1"
            :src="scene.video[m].av1"
            :type="VIDEO_TYPES.av1"
          >
          <source
            :src="scene.video[m].h264"
            :type="VIDEO_TYPES.h264"
          >
        </video>
      </div>
    </template>
    <!-- Pages fanning out over the window. -->
    <div
      v-for="beat in pageBeats"
      :key="beat.id"
      class="mk-fan"
      :class="{ 'is-open': fanOpen }"
    >
      <div class="mk-fan__scrim" />
      <template v-if="load">
        <img
          v-for="(p, i) in beat.pages"
          :key="p.src"
          loading="lazy"
          decoding="async"
          class="mk-fan__page"
          :style="pageVars(beat, i)"
          :sizes="mode === 'inline' ? '(max-width: 639px) 40vw, 22vw' : '18vw'"
          :srcset="srcsetFor(p)"
          :src="p.src"
          :width="p.width"
          :height="p.height"
          :alt="i === 0 ? beatAlt(beat) : ''"
        >
      </template>
    </div>
  </div>
</template>
