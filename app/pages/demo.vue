<script setup lang="ts">
import { SOURCE_REPO_URL } from '~~/shared/config/links'
import { DEMO_VIDEO } from '~~/shared/media/demoVideo'
import { pageBreadcrumbs } from '~~/shared/seo/breadcrumbs'
import type { PageStructuredData } from '~/composables/marketing/usePageStructuredData'

// /demo: the two-minute demo video (scripts/demo-video/), so a link to it
// plays in the browser instead of a download page. Hosted marketing site
// only (it advertises markoto.app); everywhere else the middleware 404s.
// The files are content-hashed under public/media/ and cached for a year
// (server/utils/rendering/mediaAssetHeaders.ts); CSP `media-src 'self'`
// covers them.

definePageMeta({ layout: 'marketing', middleware: 'marketing-pages' })

const { t } = useI18n()
const { siteUrl } = useInstanceConfig()

const title = computed(() => t('demo.title'))
const description = computed(() => t('demo.metaDescription'))
const videoUrl = computed(() => (siteUrl.value ? `${siteUrl.value}${DEMO_VIDEO.src}` : undefined))
const posterUrl = computed(() => (siteUrl.value ? `${siteUrl.value}${DEMO_VIDEO.poster}` : undefined))
const minutes = Math.max(1, Math.round(DEMO_VIDEO.durationSeconds / 60))

// Language versions (`/demo`, `/de/demo`, ...): hreflang, noindex while unreviewed.
const { noindex } = useUiPageLanguages('/demo')
const route = useRoute()
const marketingPath = useMarketingPath()
useMarketingSeo({ title, description: () => description.value, noindex: () => noindex.value })
useSeoMeta({
  ogVideo: () => videoUrl.value,
  ogVideoSecureUrl: () => (videoUrl.value?.startsWith('https://') ? videoUrl.value : undefined),
  ogVideoType: () => (videoUrl.value ? 'video/mp4' : undefined),
  ogVideoWidth: () => (videoUrl.value ? DEMO_VIDEO.width : undefined),
  ogVideoHeight: () => (videoUrl.value ? DEMO_VIDEO.height : undefined)
})

/** ISO 8601 duration, e.g. PT1M59S. */
function isoDuration(seconds: number): string {
  return `PT${Math.floor(seconds / 60)}M${seconds % 60}S`
}

// None on an unreviewed (noindex) language version.
usePageStructuredData(() => (noindex.value ? null : demoStructuredData()))

function demoStructuredData(): PageStructuredData {
  return {
    name: title.value,
    description: description.value,
    breadcrumbs: pageBreadcrumbs(route.path, title.value),
    about: [{ self: true }],
    extraNodes: videoUrl.value && posterUrl.value
      ? [{
          '@type': 'VideoObject',
          '@id': `${siteUrl.value}${route.path}#video`,
          'name': t('demo.heading'),
          'description': description.value,
          'thumbnailUrl': posterUrl.value,
          'contentUrl': videoUrl.value,
          'uploadDate': DEMO_VIDEO.published,
          'duration': isoDuration(DEMO_VIDEO.durationSeconds),
          'width': DEMO_VIDEO.width,
          'height': DEMO_VIDEO.height
        }]
      : []
  }
}
</script>

<template>
  <div
    class="max-w-5xl mx-auto px-4 py-10 sm:py-16"
    data-testid="demo-page"
  >
    <p class="font-mono text-[11px] tracking-[0.06em] uppercase text-muted">
      {{ t('demo.eyebrow', { n: minutes }) }}
    </p>
    <h1 class="mt-3 font-serif font-light text-4xl sm:text-5xl tracking-tight text-balance">
      {{ t('demo.heading') }}
    </h1>
    <div class="mt-8 overflow-hidden rounded-lg border border-default bg-default">
      <video
        class="block w-full h-auto aspect-video"
        controls
        playsinline
        preload="metadata"
        :poster="DEMO_VIDEO.poster"
        :width="DEMO_VIDEO.width"
        :height="DEMO_VIDEO.height"
        :aria-label="t('demo.videoLabel')"
        data-testid="demo-video"
      >
        <source
          :src="DEMO_VIDEO.src"
          type="video/mp4"
        >
        <!-- Music, no speech: the captions carry the cards' text. -->
        <track
          kind="captions"
          srclang="en"
          :label="t('demo.captionsLabel')"
          :src="DEMO_VIDEO.captions"
        >
        <a :href="DEMO_VIDEO.src">{{ t('demo.download') }}</a>
      </video>
    </div>
    <div class="mt-6 flex flex-wrap items-center gap-3">
      <UButton
        :to="marketingPath('/')"
        color="neutral"
        icon="i-lucide-arrow-left"
        data-testid="demo-home"
      >
        {{ t('demo.home') }}
      </UButton>
      <UButton
        :to="SOURCE_REPO_URL"
        target="_blank"
        rel="noopener"
        color="neutral"
        variant="outline"
        icon="i-simple-icons-github"
        data-testid="demo-source"
      >
        {{ t('demo.source') }}
      </UButton>
    </div>
  </div>
</template>
