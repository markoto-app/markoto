<script setup lang="ts">
import { srcsetFor, VIDEO_TYPES, type TourSceneId } from '~~/shared/tour/manifest'

// One product-tour scene (public/tour/, the clips recorded from the real
// app) for marketing content:
//
//   ::tour-clip{scene="themes"}
//   ::
//
// Server-rendered poster in light + dark (CSS-toggled on `html.dark`, the
// Wordmark pattern), and a muted looping video of the visible mode that
// plays while the clip is mostly in view. Videos are `preload="none"`;
// with reduced motion only the poster shows.
const props = defineProps<{ scene: TourSceneId }>()

const { t } = useI18n()
const scene = (await useTourManifest()).scenes.find(s => s.id === props.scene)
const modes = ['light', 'dark'] as const

const root = ref<HTMLElement | null>(null)
const videos = ref<HTMLVideoElement[]>([])
const playing = ref(false)
let observer: IntersectionObserver | null = null

onMounted(() => {
  if (!scene?.video || !root.value) return
  if (globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  observer = new IntersectionObserver(([entry]) => {
    const dark = document.documentElement.classList.contains('dark')
    for (const video of videos.value) {
      const visibleMode = video.dataset.mode === (dark ? 'dark' : 'light')
      if (entry?.isIntersecting && visibleMode) {
        video.play().then(
          () => {
            playing.value = true
          },
          () => {} // autoplay refused: the poster stays
        )
      } else {
        video.pause()
      }
    }
  }, { threshold: 0.6 })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <figure
    v-if="scene?.poster"
    ref="root"
    class="mk-tour-clip mk-wide not-prose"
    :class="{ 'is-playing': playing }"
    data-testid="marketing-tour-clip"
  >
    <div
      v-for="m in modes"
      :key="m"
      class="mk-tour-clip__mode"
      :class="`mk-tour-clip__mode--${m}`"
    >
      <img
        loading="lazy"
        class="mk-tour-clip__media"
        :src="scene.poster[m].src"
        :srcset="srcsetFor(scene.poster[m])"
        sizes="(min-width: 1100px) 1100px, 100vw"
        :width="scene.poster[m].width"
        :height="scene.poster[m].height"
        :alt="m === 'light' ? t(`tour.alt.${scene.id}`) : ''"
        :aria-hidden="m === 'dark' ? 'true' : undefined"
        decoding="async"
      >
      <video
        v-if="scene.video"
        ref="videos"
        class="mk-tour-clip__media mk-tour-clip__video"
        :data-mode="m"
        muted
        loop
        playsinline
        preload="none"
        aria-hidden="true"
        :width="scene.video[m].width"
        :height="scene.video[m].height"
      >
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
  </figure>
</template>

<style scoped>
.mk-tour-clip {
  margin: 24px 0 32px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--ui-bg-muted);
}
.mk-tour-clip__mode { position: relative; }
.mk-tour-clip__mode--dark { display: none; }
html.dark .mk-tour-clip__mode--light { display: none; }
html.dark .mk-tour-clip__mode--dark { display: block; }
.mk-tour-clip__media { display: block; width: 100%; height: auto; }
.mk-tour-clip__video {
  position: absolute;
  inset: 0;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 300ms ease;
}
.mk-tour-clip.is-playing .mk-tour-clip__video { opacity: 1; }
</style>
