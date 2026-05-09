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
type AnnotationKind = 'arrow' | 'box' | 'pin'
type Annotation = {
  label: string
  kind: AnnotationKind
  x: number
  y: number
  w: number
  h: number
}
type NextLink = { slug: string, why: string }

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
  annotations?: Annotation[]
}
type OutcomeEntry = {
  kind: 'outcome'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
  highlights?: Highlight[]
  annotations?: Annotation[]
  hero?: true
}
type Entry = ChapterEntry | NarrationEntry | ApproachEntry | OutcomeEntry

type Theme = 'light' | 'dark'
type Form = 'desktop' | 'mobile'
type Variant = `${Theme}-${Form}`

type Manifest = {
  version: 2
  title: string
  slug: string
  locale: string
  variant: Variant
  viewport: { w: number, h: number }
  entries: Entry[]
  next?: NextLink
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
// Defer color-mode read to onMounted — useColorMode() returns 'light' on SSR
// (no prefers-color-scheme + no localStorage), so reading at top-level causes
// hydration mismatch when the user's actual mode is dark. Manifest fetch is
// already client-only (server: false), so SSR templating doesn't see the
// derived variant — but exposing the colorMode ref through `currentTheme`
// would still trigger Vue's hydration tracking on any reactive consumer
// added later. The brief light-mode flash on first paint is acceptable for
// this component; see app/AGENTS.md "Common Vue conventions" section.
const colorMode = useColorMode()
const colorModeValue = ref<'light' | 'dark'>('light')
onMounted(() => {
  colorModeValue.value = colorMode.value === 'dark' ? 'dark' : 'light'
})
watch(() => colorMode.value, (v) => {
  colorModeValue.value = v === 'dark' ? 'dark' : 'light'
})
const isMobile = useMediaQuery('(max-width: 639px)')

const currentTheme = computed<Theme>(() => (colorModeValue.value === 'dark' ? 'dark' : 'light'))
const currentForm = computed<Form>(() => (isMobile.value ? 'mobile' : 'desktop'))
const currentVariant = computed<Variant>(() => `${currentTheme.value}-${currentForm.value}`)

const reqUrl = useRequestURL()
const flowUrl = (id: string, locale: string, variant: Variant) =>
  `${reqUrl.origin}/flows/${id}/${locale}/${variant}/manifest.json`

// Variant fallback chain for a given locale: try the exact match
// first, then degrade ONE axis at a time before degrading both.
// "Same form, different theme" sits closer to the requested variant
// than "different form, same theme" — readers tolerate a wrong
// theme more than a wrong form factor (mobile users seeing desktop
// chrome at 390px wide is jarring).
function variantChain(): Variant[] {
  const t = currentTheme.value
  const otherT: Theme = t === 'light' ? 'dark' : 'light'
  const f = currentForm.value
  const otherF: Form = f === 'desktop' ? 'mobile' : 'desktop'
  return [
    `${t}-${f}`,
    `${otherT}-${f}`,
    `${t}-${otherF}`,
    `${otherT}-${otherF}`
  ]
}

async function fetchWithFallbacks(id: string): Promise<Manifest> {
  const locales = i18nLocale.value === props.defaultLocale
    ? [i18nLocale.value]
    : [i18nLocale.value, props.defaultLocale]
  let lastErr: unknown = null
  for (const locale of locales) {
    for (const variant of variantChain()) {
      try {
        return await $fetch<Manifest>(flowUrl(id, locale, variant))
      } catch (e) {
        lastErr = e
      }
    }
  }
  throw lastErr ?? new Error(`flow ${id} not found`)
}

// Client-only fetch. The resolved variant depends on the user's
// color mode AND viewport, both of which can differ between SSR and
// the client's first paint — committing the SSR payload would force
// a refetch on the client (manifest briefly null), triggering a
// hydration mismatch on the slideshow tree. `server: false` + `lazy:
// true` defers the fetch until after hydration; the component starts
// as an empty placeholder and populates client-side.
const { data: manifest, error } = useAsyncData<Manifest | null>(
  () => `flow:${props.id ?? props.path}:${i18nLocale.value}:${currentVariant.value}`,
  async () => {
    if (props.path) {
      const url = props.path.startsWith('http') ? props.path : `${reqUrl.origin}${props.path}`
      return await $fetch<Manifest>(url)
    }
    if (!props.id) throw new Error('<Flow> requires either `id` or `path`')
    return await fetchWithFallbacks(props.id)
  },
  { watch: [i18nLocale, currentVariant], server: false, lazy: true }
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
        const n = Number.parseInt(raw, 10) - 1
        return Number.isInteger(n) && n >= 0 ? n : 0
      },
      // Slide 1 is the default — return null so the param drops out
      // of the URL when at the start.
      set: idx => (idx <= 0 ? null : String(idx + 1))
    }
  }
)

// Slide auto-advance via `useTimeoutFn` — auto-cleans on scope dispose
// and gives us a `stop()` we can call from `stopPlay`/`scheduleAdvance`
// without tracking the timer id manually. The interval is a getter so
// each slide can have its own duration. `immediate: false` so the
// timer doesn't fire until we explicitly start it.
const playTimeout = useTimeoutFn(
  () => {
    if (slideIdx.value < entries.value.length - 1) {
      slideIdx.value += 1
      playProgress.value = 0
      scheduleAdvance()
    } else {
      isPlaying.value = false
    }
  },
  () => entries.value[slideIdx.value] ? durationFor(entries.value[slideIdx.value]!) : 3000,
  { immediate: false }
)

function stopPlay() {
  isPlaying.value = false
  playProgress.value = 0
  playTimeout.stop()
}
function scheduleAdvance() {
  playTimeout.stop()
  if (!isPlaying.value) return
  playProgress.value = 1
  playTimeout.start()
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
const goPrev = () => {
  stopPlay()
  if (slideIdx.value > 0) slideIdx.value -= 1
}
const goNext = () => {
  stopPlay()
  if (slideIdx.value < entries.value.length - 1) slideIdx.value += 1
}
const goStart = () => {
  stopPlay()
  slideIdx.value = 0
}
const goEnd = () => {
  stopPlay()
  if (entries.value.length) slideIdx.value = entries.value.length - 1
}

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

// useTimeoutFn auto-stops on scope dispose — no manual onUnmounted.

// Keyboard nav for slides — bound to the slides container so the
// shortcuts only fire when it has focus (tabIndex on the wrapper).
const slidesEl = ref<HTMLElement | null>(null)
onKeyStroke('ArrowLeft', (e) => {
  e.preventDefault()
  goPrev()
}, { target: slidesEl })
onKeyStroke('ArrowRight', (e) => {
  e.preventDefault()
  goNext()
}, { target: slidesEl })
onKeyStroke(' ', (e) => {
  e.preventDefault()
  togglePlay()
}, { target: slidesEl })

// Touch + mouse-drag swipe nav — universal "next slide on swipe-left,
// prev slide on swipe-right" pattern (Instagram stories / iOS Photos).
// Uses Pointer Events so a desktop mouse drag also works for testing.
// The 50px threshold filters out accidental drags during text selection
// and lets short flicks register as swipes.
usePointerSwipe(slidesEl, {
  threshold: 50,
  onSwipeEnd(_event, direction) {
    if (direction === 'left') goNext()
    else if (direction === 'right') goPrev()
  }
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
  if (s.kind === 'outcome' && s.highlights?.some(h => h.y + h.h > bottomQuarter)) return true
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
// Direction-anchoring annotations for the current slide. Approach
// frames carry these on click targets; outcome frames may carry
// them when an author used flow.shot for a "scan this" moment
// rather than a celebration.
const imageAnnotations = computed<Annotation[]>(() => {
  const s = currentSlide.value
  if (s?.kind === 'approach' || s?.kind === 'outcome') return s.annotations ?? []
  return []
})
const liveCursor = computed(() => visualCursor(currentSlide.value))

// Hero frame: the first outcome marked with `hero: true`. Rendered
// at the top of the embed as a "what you're about to learn"
// preview. Falls back to null when no outcome is marked, in which
// case the hero strip is omitted entirely.
const _heroEntry = computed<OutcomeEntry | null>(() => {
  for (const e of entries.value) {
    if (e.kind === 'outcome' && e.hero) return e
  }
  return null
})

// Hand-curated forward link the flow author set via `flow.next(...)`.
// We resolve to a docs URL by looking it up in the Nuxt Content
// collection — but for the v1 ship we just route to
// `/docs/<category>/<slug>` is too brittle without the lookup, so
// we fall back to a simple slug-based href the docs gallery can
// override later. The card always shows `why`; the href is best-
// effort.
const nextLink = computed<NextLink | null>(() => manifest.value?.next ?? null)
const nextHref = computed(() => nextLink.value ? `/docs/flows/${nextLink.value.slug}` : '')
</script>

<template>
  <div
    v-if="error"
    class="my-6 p-4 border border-red-500/40 bg-red-500/5 rounded text-sm"
  >
    Flow <code>{{ id ?? path }}</code> failed to load: {{ error.message }}
  </div>

  <!-- docs-wide opts this component into the full-bleed grid column
       in the docs article layout (see app/pages/docs/[...slug].vue's
       `.docs-article > :deep(.docs-wide)` rule). -->
  <div
    v-else-if="manifest"
    class="my-8 not-prose docs-wide"
  >
    <h3
      v-if="!hideTitle"
      class="text-lg font-semibold mb-4"
    >
      {{ manifest.title }}
    </h3>

    <!-- Hero frame intentionally NOT rendered. Manifest still carries
         `heroEntry` and the script resolver is live, so re-enabling
         is one git revert away (search for "jumpToHero" + "heroEntry"
         in history). The payoff frame still appears in the slideshow
         proper as a normal outcome shot — only the redundant top-
         strip surface is suppressed. -->

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
          :annotations="imageAnnotations"
          :viewport="manifest.viewport"
          :show-cursor="showCursor"
          :show-chrome="showChrome"
          :chrome-domain="effectiveChromeDomain"
          :show-highlights="showHighlights"
          :is-touch="manifest.variant.endsWith('mobile')"
          @click="togglePlay"
        />
        <Transition
          enter-active-class="transition-opacity duration-200"
          leave-active-class="transition-opacity duration-150"
          enter-from-class="opacity-0"
          leave-to-class="opacity-0"
          mode="out-in"
        >
          <!-- Slide caption. Bone (sumi-50) chip on the bone field
               of the slide rather than the previous black/45 wash —
               the dark-on-dark-gray combo was unreadable in light
               mode and read as "video player chrome". `bg-muted/95`
               keeps just enough translucency for the chip to feel
               layered without losing legibility, and `text-default`
               + `font-medium` lands the brand body voice. -->
          <div
            v-if="subtitleText"
            :key="slideIdx"
            class="absolute left-0 right-0 px-6 pointer-events-none flex justify-center"
            :class="subtitleAtTop ? 'top-4' : 'bottom-4'"
          >
            <p
              class="bg-muted/95 text-default px-4 py-2 rounded-md font-medium text-center max-w-[80%] backdrop-blur-md border border-default/60 shadow-sm"
              style="font-size: clamp(15px, 1.5vw, 19px); line-height: 1.35;"
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
              <UIcon
                name="i-lucide-skip-back"
                class="size-4"
              />
            </button>
          </UTooltip>
          <UTooltip text="Previous slide">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
              aria-label="Previous slide"
              :disabled="slideIdx === 0"
              @click="goPrev"
            >
              <UIcon
                name="i-lucide-step-back"
                class="size-4"
              />
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
              <UIcon
                name="i-lucide-step-forward"
                class="size-4"
              />
            </button>
          </UTooltip>
          <UTooltip text="Jump to last slide">
            <button
              class="size-8 inline-flex items-center justify-center rounded text-default disabled:opacity-30 hover:bg-elevated transition-colors"
              aria-label="Jump to last slide"
              :disabled="slideIdx === entries.length - 1"
              @click="goEnd"
            >
              <UIcon
                name="i-lucide-skip-forward"
                class="size-4"
              />
            </button>
          </UTooltip>
        </div>
        <span class="font-mono text-xs text-toned tabular-nums">
          {{ slideIdx + 1 }} / {{ entries.length }}
        </span>
      </div>

      <!-- "Try next" card. Hand-curated forward link the flow author
           set via flow.next(...). Routes the reader to the next
           recommended flow rather than dumping them at the end of
           the slideshow with nowhere to go. The href pattern is
           best-effort — the docs gallery is free to override the
           lookup once it lands. -->
      <NuxtLink
        v-if="nextLink"
        :to="nextHref"
        class="mt-4 flex items-center gap-3 px-4 py-3 rounded-lg border border-default bg-elevated/50 hover:bg-elevated transition-colors group"
      >
        <span class="font-mono text-[10.5px] tracking-[0.06em] uppercase text-muted shrink-0">try next</span>
        <span class="flex-1 min-w-0 text-default text-sm">{{ nextLink.why }}</span>
        <UIcon
          name="i-lucide-arrow-right"
          class="size-4 text-muted group-hover:translate-x-0.5 transition-transform shrink-0"
        />
      </NuxtLink>
    </div>
  </div>
</template>
