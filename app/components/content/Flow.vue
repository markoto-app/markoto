<script setup lang="ts">
// Embeddable flow component. Two ways to use it from MDC / a Vue page:
//
//   ::flow{id="create-document"}                       — scroll mode (default)
//   ::flow{id="create-document" mode="slides"}         — paginated viewer
//   ::flow{id="create-document" images-only hide-title} — minimal embed
//   ::flow{path="/internal/flows/admin/manifest.json"} — escape hatch for non-public flows
//
// i18n: by default reads the current locale from useI18n() and fetches
// /flows/<id>/<locale>/manifest.json. Falls back to `defaultLocale`
// (en) on 404 so a missing translation degrades to source language
// rather than disappearing.

import type { ComputedRef } from 'vue'

type Highlight = { label: string, x: number, y: number, w: number, h: number }

type ShotEntry = {
  kind: 'shot'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
  highlights?: Highlight[]
}
type NarrateEntry = { kind: 'narrate', text: string }
type HeadingEntry = { kind: 'heading', level: 2 | 3, text: string }
type Entry = ShotEntry | NarrateEntry | HeadingEntry

type Variant = 'light' | 'dark'

type Manifest = {
  version: 1
  title: string
  slug: string
  locale: string
  variant: Variant
  viewport: { w: number, h: number }
  entries: Entry[]
}

const props = withDefaults(defineProps<{
  /** Flow id — looks up /flows/<id>/<locale>/manifest.json */
  id?: string
  /** Explicit manifest URL — overrides id + locale. */
  path?: string
  /** "scroll" (inline list) | "slides" (paginated viewer) */
  mode?: 'scroll' | 'slides'
  /** Hide the flow's own title heading (when wrapping with your own h2). */
  hideTitle?: boolean
  /** Hide narration + heading entries; show only screenshots + captions. */
  imagesOnly?: boolean
  /** Locale fallback if the requested locale's manifest is missing. */
  defaultLocale?: string
  /** Show or hide the cursor overlay on screenshots that have one. */
  showCursor?: boolean
  /** Show or hide the fake browser chrome above each screenshot. */
  showChrome?: boolean
  /** Domain to display in the fake address bar (cosmetic only). */
  chromeDomain?: string
  /** Show or hide the bounding-box highlights on shots that carry them. */
  showHighlights?: boolean
}>(), {
  mode: 'scroll',
  hideTitle: false,
  imagesOnly: false,
  defaultLocale: 'en',
  showCursor: true,
  showChrome: true,
  showHighlights: true
})

// Chrome-domain default comes from runtime config (NUXT_PUBLIC_DOCS_CHROME_DOMAIN)
// so deployments can override per-environment without rebuilding the
// component. Per-instance override via the prop still wins.
const runtimeConfig = useRuntimeConfig()
const effectiveChromeDomain = computed(
  () => props.chromeDomain ?? runtimeConfig.public.docs.chromeDomain
)

const { locale: i18nLocale } = useI18n()
const colorMode = useColorMode()
// Resolve color-mode preference to a concrete variant. `value` is the
// resolved value (light or dark, even when preference is 'system'),
// which is what we want — we capture two variants, not three.
const currentVariant = computed<Variant>(
  () => (colorMode.value === 'dark' ? 'dark' : 'light')
)
const oppositeVariant = (v: Variant): Variant => (v === 'light' ? 'dark' : 'light')

// Build a fully-qualified URL for the manifest fetch. On the server,
// `$fetch('/flows/...')` with a bare path goes through Nitro's internal
// route resolver — which in dev does NOT delegate to Vite's static
// handler, so public/ assets 404 during SSR. Routing through the request
// origin turns it into a real HTTP fetch that hits Vite. On the client,
// `useRequestURL().origin` resolves to `window.location.origin` — same
// behaviour as a relative path. One code path, both contexts; SSR can
// pre-render the manifest into the page (no client flash on hydration).
const reqUrl = useRequestURL()
const flowUrl = (id: string, locale: string, variant: Variant) =>
  `${reqUrl.origin}/flows/${id}/${locale}/${variant}/manifest.json`

// Fallback chain on 404:
//   1. requested locale + requested variant   (the happy path)
//   2. requested locale + opposite variant    (variant not captured for this flow)
//   3. defaultLocale + requested variant      (locale not translated yet)
//   4. defaultLocale + opposite variant       (last resort)
//   5. throw                                  (flow doesn't exist at all)
//
// We try them serially because the happy path is one request and the
// fallbacks are exceptional — parallelising would burn 4× the requests
// for the common case.
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
      // `path` may be relative (in-app) or absolute (cross-app escape hatch).
      // Only prefix the origin when it's a relative path.
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
  // Use the manifest's OWN locale + variant — not the request's. The
  // fallback chain may have given us a different (locale, variant)
  // pair than what the user asked for; image paths must point at the
  // same triple as the manifest, otherwise we'd serve dark variant
  // PNGs alongside light variant captions.
  return `/flows/${props.id}/${manifest.value.locale}/${manifest.value.variant}`
})

const visibleEntries: ComputedRef<Entry[]> = computed(() => {
  if (!manifest.value) return []
  if (!props.imagesOnly) return manifest.value.entries
  return manifest.value.entries.filter((e) => e.kind === 'shot')
})

const shots = computed(() =>
  visibleEntries.value.filter((e): e is ShotEntry => e.kind === 'shot')
)

// Slide mode state.
const slideIdx = ref(0)
const isPlaying = ref(false)
// Fraction (0..1) of the CURRENT slide's display window that has
// elapsed. Combined with slideIdx to compute progress bar width:
// bar = (slideIdx + playProgress) / total. Net effect — slide 1
// starts at 0% (idx=0, prog=0), fills smoothly to 1/total during
// its 2s display, slide 2 starts at 1/total (no jump because
// prog resets to 0 as idx increments), final slide ends at 100%.
const playProgress = ref(0)

// Auto-play: each slide is shown for SLIDE_DURATION_MS, then we
// advance. Stops when we hit the last slide. Manual prev/next
// also stops play — clicking a control = "I want to drive this".
const SLIDE_DURATION_MS = 3000
let playTimer: ReturnType<typeof setTimeout> | null = null

function clearPlayTimer() {
  if (playTimer) { clearTimeout(playTimer); playTimer = null }
}
function stopPlay() {
  isPlaying.value = false
  // Snap progress back to slide-start. Predictable: pause = "you're
  // at the beginning of this slide". Resume replays the slide.
  playProgress.value = 0
  clearPlayTimer()
}
function scheduleAdvance() {
  clearPlayTimer()
  if (!isPlaying.value) return
  // Trigger the bar to fill to next-slide's static value over the
  // slide-duration. CSS transition does the linear interpolation;
  // when the timer fires we increment slideIdx + reset progress so
  // (slideIdx + progress) stays continuous (no visual jump).
  playProgress.value = 1
  playTimer = setTimeout(() => {
    if (slideIdx.value < shots.value.length - 1) {
      slideIdx.value += 1
      playProgress.value = 0
      scheduleAdvance()
    } else {
      // Final slide — leave progress at 1 so the bar holds at 100%.
      // Don't call stopPlay() (which would snap back to 0).
      isPlaying.value = false
      clearPlayTimer()
    }
  }, SLIDE_DURATION_MS)
}
function togglePlay() {
  if (isPlaying.value) {
    stopPlay()
  } else {
    // If we're at the end with the bar full, restart from slide 1.
    if (slideIdx.value === shots.value.length - 1 && playProgress.value === 1) {
      slideIdx.value = 0
      playProgress.value = 0
    }
    isPlaying.value = true
    scheduleAdvance()
  }
}
const goPrev = () => { stopPlay(); if (slideIdx.value > 0) slideIdx.value -= 1 }
const goNext = () => { stopPlay(); if (slideIdx.value < shots.value.length - 1) slideIdx.value += 1 }

watch(visibleEntries, () => { slideIdx.value = 0; stopPlay() })

onUnmounted(clearPlayTimer)

// Keyboard nav for slides — only active when the slides container has focus,
// so embedding two on the same page doesn't have them fighting.
const slidesEl = ref<HTMLElement | null>(null)
useEventListener(slidesEl, 'keydown', (e: KeyboardEvent) => {
  if (props.mode !== 'slides') return
  if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() } else if (e.key === 'ArrowRight') { e.preventDefault(); goNext() } else if (e.key === ' ') { e.preventDefault(); togglePlay() }
})

// Progress bar width. Combines completed slides + intra-slide
// playProgress so the bar fills smoothly during autoplay AND lands
// exactly on slide-boundary values when paused / manually navigated.
const progressPct = computed(() =>
  shots.value.length ? ((slideIdx.value + playProgress.value) / shots.value.length) * 100 : 0
)
</script>

<template>
  <div v-if="error" class="my-6 p-4 border border-red-500/40 bg-red-500/5 rounded text-sm">
    Flow <code>{{ id ?? path }}</code> failed to load: {{ error.message }}
  </div>

  <!-- docs-wide opts this component into the full-bleed grid column
       in the docs article layout (see app/pages/docs/[...slug].vue's
       `.docs-article > :deep(.docs-wide)` rule). Without it, the
       Flow renders inside the narrow prose column and screenshots
       are too small to read. The class is a no-op outside the docs
       layout — Flow can still be embedded anywhere. -->
  <div v-else-if="manifest" class="my-8 not-prose docs-wide">
    <h3 v-if="!hideTitle" class="text-lg font-semibold mb-4">
      {{ manifest.title }}
    </h3>

    <!-- ─── SLIDES MODE ─────────────────────────────────────────── -->
    <!-- Layout (top-down): frame → progress bar (zero gap) →
         YouTube-style control row → prominent caption. The
         progress bar + control row read as one unit "attached"
         to the player; the caption is the editorial content. -->
    <div
      v-if="mode === 'slides' && shots.length"
      ref="slidesEl"
      tabindex="0"
      class="outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
    >
      <!-- Frame + subtitle overlay. Caption renders OVER the
           screenshot like a movie subtitle: translucent dark
           backdrop + white text + center-bottom of the frame.
           Reads on both light and dark screenshots without depending
           on the underlying theme. Pointer-events-none so users
           can still interact with anything behind it (none here,
           but defensive). The <Transition> gives a soft fade
           between slides instead of a hard cut, matching the
           cursor's animated motion. -->
      <div class="relative">
        <FlowFrame
          :src="`${baseUrl}/${shots[slideIdx].file}`"
          :caption="shots[slideIdx].caption"
          :cursor="shots[slideIdx].cursor"
          :path="shots[slideIdx].path"
          :highlights="shots[slideIdx].highlights"
          :viewport="manifest.viewport"
          :show-cursor="showCursor"
          :show-chrome="showChrome"
          :chrome-domain="effectiveChromeDomain"
          :show-highlights="showHighlights"
          hide-caption
        />
        <Transition
          enter-active-class="transition-opacity duration-200"
          leave-active-class="transition-opacity duration-150"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
          mode="out-in"
        >
          <div
            :key="slideIdx"
            class="absolute left-0 right-0 bottom-4 px-6 pointer-events-none flex justify-center"
          >
            <p
              class="bg-black/75 text-white px-4 py-2 rounded-md text-base md:text-lg font-medium text-center max-w-[80%] backdrop-blur-sm shadow-lg"
            >
              {{ shots[slideIdx].caption }}
            </p>
          </div>
        </Transition>
      </div>

      <!-- Progress bar — flush against the bottom of the frame
           (no gap). Width transitions linearly over the slide
           duration when autoplay is running so the bar visibly
           fills as the slide is shown; jumps quickly when the
           user clicks prev / next. -->
      <div class="h-1 bg-elevated overflow-hidden">
        <div
          class="h-full bg-primary"
          :style="{
            width: `${progressPct}%`,
            transition: isPlaying ? `width ${SLIDE_DURATION_MS}ms linear` : 'width 0.25s ease-out'
          }"
        />
      </div>

      <!-- YouTube-style control row: borderless icon buttons grouped
           on the left (prev / play / next), counter as a "time" on
           the right. Hover gives a subtle wash so users know
           something's clickable. -->
      <div class="flex items-center justify-between px-2 py-1.5 bg-elevated/50">
        <div class="flex items-center">
          <button
            class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
            aria-label="Previous slide"
            :disabled="slideIdx === 0"
            @click="goPrev"
          >
            <UIcon name="i-lucide-skip-back" class="size-4" />
          </button>
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
          <button
            class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
            aria-label="Next slide"
            :disabled="slideIdx === shots.length - 1"
            @click="goNext"
          >
            <UIcon name="i-lucide-skip-forward" class="size-4" />
          </button>
        </div>
        <span class="font-mono text-xs text-toned tabular-nums">
          {{ slideIdx + 1 }} / {{ shots.length }}
        </span>
      </div>

    </div>

    <!-- ─── SCROLL MODE (default) ───────────────────────────────── -->
    <div v-else class="space-y-6">
      <template v-for="(e, i) in visibleEntries" :key="i">
        <h2 v-if="e.kind === 'heading' && e.level === 2" class="text-xl font-semibold">
          {{ e.text }}
        </h2>
        <h3 v-else-if="e.kind === 'heading'" class="text-base font-semibold">
          {{ e.text }}
        </h3>
        <aside
          v-else-if="e.kind === 'narrate'"
          class="px-4 py-3 border-l-2 border-primary/40 bg-primary/5 text-sm"
        >
          {{ e.text }}
        </aside>
        <FlowFrame
          v-else
          :src="`${baseUrl}/${e.file}`"
          :caption="e.caption"
          :cursor="e.cursor"
          :path="e.path"
          :highlights="e.highlights"
          :viewport="manifest.viewport"
          :show-cursor="showCursor"
          :show-chrome="showChrome"
          :chrome-domain="effectiveChromeDomain"
          :show-highlights="showHighlights"
        />
      </template>
    </div>
  </div>
</template>
