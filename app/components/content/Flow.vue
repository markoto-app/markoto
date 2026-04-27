<script setup lang="ts">
// Embeddable flow component (slides-only).
//
//   ::flow{id="quick-share"}                    — default
//   ::flow{id="quick-share" hide-title}         — minimal embed
//   ::flow{path="/internal/flows/admin/manifest.json"} — escape hatch
//
// Manifest v2 introduces four slide kinds:
//   • chapter   — text-only section break (no screenshot)
//   • narration — exposition; screenshot + large subtitle, no cursor
//   • approach  — "click X" — cursor on target, before-state
//   • outcome   — "X happens" — same cursor as approach, after-state
//
// i18n: by default reads the current locale from useI18n() and fetches
// /flows/<id>/<locale>/<variant>/manifest.json. Falls back to
// `defaultLocale` (en) on 404.

import type { ComputedRef } from 'vue'
import { useRouteQuery } from '@vueuse/router'

type Highlight = { label: string, x: number, y: number, w: number, h: number }

type ChapterEntry = { kind: 'chapter', text: string, level: 2 | 3 }
type NarrationEntry = {
  kind: 'narration'
  text: string
  file: string
  cursor: { x: number, y: number } | null
  path: string
}
type ApproachEntry = {
  kind: 'approach'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
}
type OutcomeEntry = {
  kind: 'outcome'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
  highlights?: Highlight[]
}
type Entry = ChapterEntry | NarrationEntry | ApproachEntry | OutcomeEntry

type Variant = 'light' | 'dark'

type Manifest = {
  version: 2
  title: string
  slug: string
  locale: string
  variant: Variant
  viewport: { w: number, h: number }
  entries: Entry[]
}

const props = withDefaults(defineProps<{
  /** Flow id — looks up /flows/<id>/<locale>/<variant>/manifest.json */
  id?: string
  /** Explicit manifest URL — overrides id + locale. */
  path?: string
  /** Hide the flow's own title heading (when wrapping with your own h2). */
  hideTitle?: boolean
  /** Locale fallback if the requested locale's manifest is missing. */
  defaultLocale?: string
  /** Show or hide the cursor overlay on shots that have one. */
  showCursor?: boolean
  /** Show or hide the fake browser chrome above each screenshot. */
  showChrome?: boolean
  /** Domain to display in the fake address bar (cosmetic only). */
  chromeDomain?: string
  /** Show or hide the bounding-box highlights on outcome shots. */
  showHighlights?: boolean
}>(), {
  hideTitle: false,
  defaultLocale: 'en',
  showCursor: true,
  showChrome: true,
  showHighlights: true
})

const runtimeConfig = useRuntimeConfig()
const effectiveChromeDomain = computed(
  () => props.chromeDomain ?? runtimeConfig.public.docs.chromeDomain
)

const { locale: i18nLocale } = useI18n()
const colorMode = useColorMode()
const currentVariant = computed<Variant>(
  () => (colorMode.value === 'dark' ? 'dark' : 'light')
)
const oppositeVariant = (v: Variant): Variant => (v === 'light' ? 'dark' : 'light')

const reqUrl = useRequestURL()
const flowUrl = (id: string, locale: string, variant: Variant) =>
  `${reqUrl.origin}/flows/${id}/${locale}/${variant}/manifest.json`

async function fetchWithFallbacks(id: string): Promise<Manifest> {
  const candidates: Array<{ locale: string, variant: Variant }> = [
    { locale: i18nLocale.value, variant: currentVariant.value },
    { locale: i18nLocale.value, variant: oppositeVariant(currentVariant.value) }
  ]
  if (i18nLocale.value !== props.defaultLocale) {
    candidates.push(
      { locale: props.defaultLocale, variant: currentVariant.value },
      { locale: props.defaultLocale, variant: oppositeVariant(currentVariant.value) }
    )
  }
  let lastErr: unknown = null
  for (const c of candidates) {
    try {
      return await $fetch<Manifest>(flowUrl(id, c.locale, c.variant))
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error(`flow ${id} not found`)
}

const { data: manifest, error } = await useAsyncData<Manifest | null>(
  () => `flow:${props.id ?? props.path}:${i18nLocale.value}:${currentVariant.value}`,
  async () => {
    if (props.path) {
      const url = props.path.startsWith('http') ? props.path : `${reqUrl.origin}${props.path}`
      return await $fetch<Manifest>(url)
    }
    if (!props.id) throw new Error('<Flow> requires either `id` or `path`')
    return await fetchWithFallbacks(props.id)
  },
  { watch: [i18nLocale, currentVariant] }
)

const baseUrl = computed(() => {
  if (!manifest.value) return ''
  if (props.path) return props.path.replace(/\/manifest\.json$/, '')
  return `/flows/${props.id}/${manifest.value.locale}/${manifest.value.variant}`
})

const entries: ComputedRef<Entry[]> = computed(() => manifest.value?.entries ?? [])

// Per-slide-kind autoplay durations. Approach gets the longest dwell
// (read caption + watch cursor arrive); outcome is read-and-move-on;
// chapter is a quick beat; narration scales with text length.
function durationFor(e: Entry): number {
  if (e.kind === 'chapter') return 2000
  if (e.kind === 'narration') return Math.min(8000, 2000 + e.text.length * 30)
  if (e.kind === 'approach') return 3000
  return 2500
}

// Slide state. Image, caption, and cursor all bind to slideIdx —
// the v1 model lagged the image swap so the cursor could "arrive"
// on the previous screenshot, but with v2's approach+outcome pairs
// the cursor's destination IS the new approach's screenshot context,
// so swapping immediately reads correctly. The cursor's CSS
// transition on left/top/opacity still gives smooth motion between
// consecutive cursor-bearing slides.
const slideIdx = ref(0)
const isPlaying = ref(false)
const playProgress = ref(0)

// URL sync — `?slide-<flowId>=N` (1-indexed for human readability).
// `useRouteQuery` is the router-aware VueUse helper: it round-trips
// through vue-router's reactive `route.query`, so reads + writes go
// through the same pipeline Nuxt + the browser already use. `mode:
// 'replace'` rewrites in place (no history pollution); the
// transform pair (parseInt → string) shapes the typed value.
// Multiple flows on one page get distinct param keys via the id.
const slideParamKey = computed(() => {
  const base = props.id ?? props.path?.split('/').filter(Boolean).pop() ?? 'flow'
  return `slide-${base}`
})
const slideQuery = useRouteQuery<string | null, number>(
  slideParamKey.value,
  null,
  {
    mode: 'replace',
    transform: {
      get: (raw) => {
        if (typeof raw !== 'string') return 0
        const n = parseInt(raw, 10) - 1
        return Number.isInteger(n) && n >= 0 ? n : 0
      },
      // Slide 1 is the default — return null so the param drops out
      // of the URL when at the start.
      set: (idx) => (idx <= 0 ? null : String(idx + 1))
    }
  }
)

let playTimer: ReturnType<typeof setTimeout> | null = null
function clearPlayTimer() {
  if (playTimer) { clearTimeout(playTimer); playTimer = null }
}
function stopPlay() {
  isPlaying.value = false
  playProgress.value = 0
  clearPlayTimer()
}
function scheduleAdvance() {
  clearPlayTimer()
  if (!isPlaying.value) return
  const dur = entries.value[slideIdx.value] ? durationFor(entries.value[slideIdx.value]!) : 3000
  playProgress.value = 1
  playTimer = setTimeout(() => {
    if (slideIdx.value < entries.value.length - 1) {
      slideIdx.value += 1
      playProgress.value = 0
      scheduleAdvance()
    } else {
      isPlaying.value = false
      clearPlayTimer()
    }
  }, dur)
}
function togglePlay() {
  if (isPlaying.value) {
    stopPlay()
  } else {
    if (slideIdx.value === entries.value.length - 1 && playProgress.value === 1) {
      slideIdx.value = 0
      playProgress.value = 0
    }
    isPlaying.value = true
    scheduleAdvance()
  }
}
const goPrev = () => { stopPlay(); if (slideIdx.value > 0) slideIdx.value -= 1 }
const goNext = () => { stopPlay(); if (slideIdx.value < entries.value.length - 1) slideIdx.value += 1 }
const goStart = () => { stopPlay(); slideIdx.value = 0 }
const goEnd = () => { stopPlay(); if (entries.value.length) slideIdx.value = entries.value.length - 1 }

// Cursor coords for an entry — chapter has none; narration has
// recorded coords but the renderer hides the cursor anyway.
function visualCursor(e: Entry | undefined): { x: number, y: number } | null {
  if (!e) return null
  if (e.kind === 'approach' || e.kind === 'outcome') return e.cursor
  return null
}

watch(entries, () => {
  slideIdx.value = 0
  stopPlay()
})

// Hydrate slideIdx from URL once entries are populated (the URL
// might point at slide N but we can't trust it until we know the
// flow has at least N entries). Then watch slideIdx → slideQuery
// to write changes back. The two refs converge: bookmarking ?slide-
// quick-share=5 lands you on slide 5; manual prev/next rewrites
// the URL via vue-router's replaceState.
let hasHydrated = false
watch(entries, (newEntries) => {
  if (hasHydrated || newEntries.length === 0) return
  hasHydrated = true
  const fromUrl = slideQuery.value
  if (fromUrl >= 0 && fromUrl < newEntries.length) {
    slideIdx.value = fromUrl
  }
}, { immediate: true })

watch(slideIdx, (idx) => {
  if (slideQuery.value !== idx) slideQuery.value = idx
})

onUnmounted(() => { clearPlayTimer() })

// Keyboard nav for slides.
const slidesEl = ref<HTMLElement | null>(null)
useEventListener(slidesEl, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() } else if (e.key === 'ArrowRight') { e.preventDefault(); goNext() } else if (e.key === ' ') { e.preventDefault(); togglePlay() }
})

const progressPct = computed(() =>
  entries.value.length ? ((slideIdx.value + playProgress.value) / entries.value.length) * 100 : 0
)

const currentSlideDuration = computed(() =>
  entries.value[slideIdx.value] ? durationFor(entries.value[slideIdx.value]!) : 3000
)

const currentSlide = computed(() => entries.value[slideIdx.value])

// Cursor opacity: hidden on chapter + narration, visible on
// approach + outcome. CSS-transitioned in FlowFrame so the cursor
// fades in / out smoothly across kind changes.
const cursorOpacity = computed(() => {
  const s = currentSlide.value
  if (!s) return 0
  if (s.kind === 'chapter' || s.kind === 'narration') return 0
  return 1
})

// Subtitle position: above-the-content when the cursor or any outcome
// highlight sits in the bottom quarter of the viewport.
const subtitleAtTop = computed(() => {
  if (!manifest.value) return false
  const s = currentSlide.value
  if (!s) return false
  const bottomQuarter = manifest.value.viewport.h * 0.75
  if ((s.kind === 'approach' || s.kind === 'outcome') && s.cursor && s.cursor.y > bottomQuarter) return true
  if (s.kind === 'outcome' && s.highlights?.some((h) => h.y + h.h > bottomQuarter)) return true
  return false
})

// Subtitle: only shown for approach/outcome. Chapter + narration
// carry their text inside the frame's card body.
const subtitleText = computed<string | null>(() => {
  const s = currentSlide.value
  if (!s) return null
  if (s.kind === 'approach' || s.kind === 'outcome') return s.caption
  return null
})

// Frame body: a card (chapter or narration) for text-only kinds,
// otherwise an image + cursor + (for outcomes) highlights.
type Card = { kind: 'chapter' | 'narration', text: string } | null
const cardContent = computed<Card>(() => {
  const s = currentSlide.value
  if (!s) return null
  if (s.kind === 'chapter') return { kind: 'chapter', text: s.text }
  if (s.kind === 'narration') return { kind: 'narration', text: s.text }
  return null
})
const imagePath = computed(() => {
  const s = currentSlide.value
  if (!s || s.kind === 'chapter' || s.kind === 'narration') return ''
  return s.path
})
const imageFile = computed(() => {
  const s = currentSlide.value
  if (!s || s.kind === 'chapter' || s.kind === 'narration') return null
  return s.file
})
const imageHighlights = computed(() => {
  const s = currentSlide.value
  if (s?.kind === 'outcome') return s.highlights ?? []
  return []
})
const liveCursor = computed(() => visualCursor(currentSlide.value))
</script>

<template>
  <div v-if="error" class="my-6 p-4 border border-red-500/40 bg-red-500/5 rounded text-sm">
    Flow <code>{{ id ?? path }}</code> failed to load: {{ error.message }}
  </div>

  <!-- docs-wide opts this component into the full-bleed grid column
       in the docs article layout (see app/pages/docs/[...slug].vue's
       `.docs-article > :deep(.docs-wide)` rule). -->
  <div v-else-if="manifest" class="my-8 not-prose docs-wide">
    <h3 v-if="!hideTitle" class="text-lg font-semibold mb-4">
      {{ manifest.title }}
    </h3>

    <div
      v-if="entries.length"
      ref="slidesEl"
      tabindex="0"
      class="outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
    >
      <!-- Frame + subtitle overlay. Click on the IMAGE region (not
           the browser chrome) toggles play/pause — FlowFrame emits
           the click so the chrome above stays unclickable. -->
      <div class="relative">
        <FlowFrame
          :src="imageFile ? `${baseUrl}/${imageFile}` : null"
          :card="cardContent"
          :cursor="liveCursor"
          :cursor-opacity="cursorOpacity"
          :path="imagePath"
          :highlights="imageHighlights"
          :viewport="manifest.viewport"
          :show-cursor="showCursor"
          :show-chrome="showChrome"
          :chrome-domain="effectiveChromeDomain"
          :show-highlights="showHighlights"
          @click="togglePlay"
        />
        <Transition
          enter-active-class="transition-opacity duration-200"
          leave-active-class="transition-opacity duration-150"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
          mode="out-in"
        >
          <div
            v-if="subtitleText"
            :key="slideIdx"
            class="absolute left-0 right-0 px-6 pointer-events-none flex justify-center"
            :class="subtitleAtTop ? 'top-4' : 'bottom-4'"
          >
            <p
              class="bg-black/45 text-white px-4 py-2 rounded-md text-base md:text-lg font-medium text-center max-w-[80%] backdrop-blur-md shadow-lg"
            >
              {{ subtitleText }}
            </p>
          </div>
        </Transition>
      </div>

      <!-- Progress bar — flush against the frame. Width transitions
           over the CURRENT slide's duration during autoplay. -->
      <div class="h-1 bg-elevated overflow-hidden">
        <div
          class="h-full bg-primary"
          :style="{
            width: `${progressPct}%`,
            transition: isPlaying ? `width ${currentSlideDuration}ms linear` : 'width 0.25s ease-out'
          }"
        />
      </div>

      <!-- Control row: jump-start / prev / play / next / jump-end. -->
      <div class="flex items-center justify-between px-2 py-1.5 bg-elevated/50">
        <div class="flex items-center">
          <UTooltip text="Jump to first slide">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
              aria-label="Jump to first slide"
              :disabled="slideIdx === 0"
              @click="goStart"
            >
              <UIcon name="i-lucide-skip-back" class="size-4" />
            </button>
          </UTooltip>
          <UTooltip text="Previous slide">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
              aria-label="Previous slide"
              :disabled="slideIdx === 0"
              @click="goPrev"
            >
              <UIcon name="i-lucide-step-back" class="size-4" />
            </button>
          </UTooltip>
          <UTooltip :text="isPlaying ? 'Pause autoplay' : 'Play autoplay'">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default hover:bg-elevated transition-colors"
              :aria-label="isPlaying ? 'Pause autoplay' : 'Play autoplay'"
              @click="togglePlay"
            >
              <UIcon
                :name="isPlaying ? 'i-lucide-pause' : 'i-lucide-play'"
                class="size-4"
              />
            </button>
          </UTooltip>
          <UTooltip text="Next slide">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
              aria-label="Next slide"
              :disabled="slideIdx === entries.length - 1"
              @click="goNext"
            >
              <UIcon name="i-lucide-step-forward" class="size-4" />
            </button>
          </UTooltip>
          <UTooltip text="Jump to last slide">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
              aria-label="Jump to last slide"
              :disabled="slideIdx === entries.length - 1"
              @click="goEnd"
            >
              <UIcon name="i-lucide-skip-forward" class="size-4" />
            </button>
          </UTooltip>
        </div>
        <span class="font-mono text-xs text-toned tabular-nums">
          {{ slideIdx + 1 }} / {{ entries.length }}
        </span>
      </div>
    </div>
  </div>
</template>
