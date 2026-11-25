<script setup lang="ts">
import { DEMO_VIDEO } from '~~/shared/media/demoVideo'

/**
 * The demo video in a lightbox over the product page (the same files as
 * /demo, self-hosted under public/media/). Loaded only once the visitor
 * asks for it (ProductTour.vue imports this component on demand), so the
 * mp4 and the captions never load with the page.
 *
 * The dialog (Reka, through UModal) traps focus, closes on Esc and on the
 * close button, and fades instead of scaling under reduced motion. Focus
 * goes back to the button that opened it. Playback starts with sound
 * right away: opening is the visitor's click. Closing pauses it.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  /** The element to focus once the dialog has closed. */
  returnFocusTo?: HTMLElement | null
}>()

const { t } = useI18n()

const videoEl = ref<HTMLVideoElement | null>(null)

watch(videoEl, (el) => {
  if (!el || !open.value) return
  // Rejected when the browser still refuses sound (e.g. the activation
  // timed out): the native controls stay, one more tap plays.
  el.play()?.catch(() => {})
})

watch(open, (isOpen) => {
  if (!isOpen) videoEl.value?.pause()
})

function onCloseAutoFocus(e: Event): void {
  const target = props.returnFocusTo
  if (!target?.isConnected) return
  e.preventDefault()
  // No scroll: on the pinned product page the button hides once the page moves.
  target.focus({ preventScroll: true })
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('demo.heading')"
    :ui="{ content: 'w-screen max-w-none rounded-none sm:w-[calc(100vw-2rem)] sm:max-w-5xl sm:rounded-lg divide-y-0 overflow-hidden' }"
    :content="{ onCloseAutoFocus }"
  >
    <template #content>
      <div
        class="flex flex-col"
        data-testid="demo-video-overlay"
        data-lenis-prevent
      >
        <div class="flex items-center justify-between gap-3 px-4 py-2">
          <p class="font-mono text-[11px] tracking-[0.06em] uppercase text-muted">
            {{ t('demo.heading') }}
          </p>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="t('common.close')"
            data-testid="demo-video-overlay-close"
            @click="open = false"
          />
        </div>
        <video
          ref="videoEl"
          class="block w-full h-auto aspect-video bg-black"
          controls
          playsinline
          preload="auto"
          :poster="DEMO_VIDEO.poster"
          :width="DEMO_VIDEO.width"
          :height="DEMO_VIDEO.height"
          :aria-label="t('demo.videoLabel')"
          data-testid="demo-video-overlay-video"
        >
          <source
            :src="DEMO_VIDEO.src"
            type="video/mp4"
          >
          <!-- Off by default: the captions repeat the text the video's
               cards already show. The player's menu turns them on. -->
          <track
            kind="captions"
            srclang="en"
            :label="t('demo.captionsLabel')"
            :src="DEMO_VIDEO.captions"
          >
          <a :href="DEMO_VIDEO.src">{{ t('demo.download') }}</a>
        </video>
      </div>
    </template>
  </UModal>
</template>
