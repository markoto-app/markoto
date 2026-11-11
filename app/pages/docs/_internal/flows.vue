<script setup lang="ts">
// Internal flow gallery. Lists every flow currently published under
// `public/flows/<slug>/` with its hero strip, title, mobile-availability
// pill, and curated "Try next" link. Useful when adding a new flow:
// land on this page, see what already exists, pick a `next:` target
// that hasn't been overused.
//
// Surface: `/docs/_internal/flows`. Not linked from the docs landing
// (the underscore prefix is the convention for internal pages —
// reachable by URL, not by navigation). The data comes from the
// `_internal/flows-index` server route which walks `public/flows/`
// and reads each manifest's title + hero + next-link.

const api = useApi()

// SSR fetch through the internal endpoint. The gallery is page-load
// only; no client-side polling needed (the underlying flows directory
// only changes when someone runs `flows:build`, which the dev server
// picks up after a refresh).
const { data } = await useAsyncData('docs:flows-gallery', () =>
  api('/api/_internal/flows-index')
)

const flows = computed(() => data.value?.flows ?? [])

// Group desktop flows separately from mobile siblings so the gallery
// reads as "the main flow + its mobile variant", not 27 cards in a
// flat list. Mobile siblings always end in `-on-mobile` per our
// naming convention; everything else is a primary entry.
const grouped = computed(() => {
  const primaries = flows.value.filter(f => !f.slug.endsWith('-on-mobile'))
  // Quick lookup so primary cards know to surface the mobile pill
  // (the API already returns `hasMobile`, but mobile siblings are
  // ALSO published as standalone slugs — we want them paired with
  // their primary, not double-listed).
  return primaries
})

const mobileSiblings = computed(() =>
  flows.value.filter(f => f.slug.endsWith('-on-mobile'))
)

useSeoMeta({
  title: 'Flow gallery (internal)',
  description: 'Every published flow at a glance.',
  // No-index: this is a debugging surface, not a marketing page.
  robots: 'noindex, nofollow'
})

definePageMeta({ layout: 'docs' })
</script>

<template>
  <div class="max-w-6xl mx-auto px-4 sm:px-6 md:px-12 py-10 md:py-16">
    <!-- Header — explain what this is. The fact that it's reachable
         by URL but not linked is intentional; people who land here
         either typed it or got it from a code comment. -->
    <header class="mb-10">
      <p class="font-mono text-[11px] uppercase tracking-[0.06em] text-muted mb-2">
        FIELD GUIDE · INTERNAL
      </p>
      <h1 class="font-serif text-3xl md:text-4xl font-normal tracking-tight mb-3">
        Flow gallery
      </h1>
      <p class="text-sm text-muted max-w-prose leading-relaxed">
        Every flow currently published under
        <code class="font-mono text-[12px] bg-muted px-1 rounded">public/flows/</code>.
        Cards link to the full slideshow on the docs site;
        “next” shows where each flow points readers afterwards.
      </p>
      <p class="text-xs text-muted mt-3">
        {{ flows.length }} flow{{ flows.length === 1 ? '' : 's' }} · {{ grouped.length }} desktop · {{ mobileSiblings.length }} mobile sibling{{ mobileSiblings.length === 1 ? '' : 's' }}
      </p>
    </header>

    <!-- Empty state. The most common cause is "you forgot to run
         `bun run flows:build` after `flows:test`". -->
    <div
      v-if="flows.length === 0"
      class="rounded-lg border border-default bg-muted p-6 text-sm text-muted"
    >
      No flows published yet. Run
      <code class="font-mono text-[12px] bg-default px-1 rounded">bun run flows</code>
      (test → build) and refresh.
    </div>

    <!-- Card grid. Each card: hero on top, title + mobile pill below,
         "Try next" footer. Hero is 16:10 (1280x800 captures); we let
         the natural aspect take over and clip overflow with object-cover
         so cards stay aligned. -->
    <ul
      v-else
      class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
    >
      <li
        v-for="flow in grouped"
        :key="flow.slug"
        class="flex flex-col rounded-lg border border-default bg-default overflow-hidden hover:border-primary/40 transition-colors"
      >
        <NuxtLink
          :to="`/docs/${flow.slug}`"
          class="block aspect-[16/10] bg-muted overflow-hidden"
        >
          <img
            v-if="flow.heroPath"
            :src="flow.heroPath"
            :alt="flow.title"
            class="w-full h-full object-cover"
            loading="lazy"
          >
          <div
            v-else
            class="w-full h-full flex items-center justify-center text-xs text-muted font-mono"
          >
            no hero
          </div>
        </NuxtLink>

        <div class="p-4 flex flex-col flex-1 gap-3">
          <div class="flex items-start justify-between gap-2">
            <NuxtLink
              :to="`/docs/${flow.slug}`"
              class="font-serif text-base font-normal tracking-tight hover:text-primary transition-colors"
            >
              {{ flow.title }}
            </NuxtLink>
            <UBadge
              v-if="flow.hasMobile"
              size="xs"
              color="neutral"
              variant="subtle"
              :title="'A mobile sibling exists at /docs/' + flow.slug + '-on-mobile'"
            >
              mobile
            </UBadge>
          </div>

          <div class="text-[10.5px] font-mono uppercase tracking-[0.06em] text-muted">
            slug · {{ flow.slug }}
          </div>

          <!-- Forward route. Same field <Flow> renders as the "Try
               next" card after the slideshow. Surfacing it here makes
               it easy to spot orphans (flows that nothing points at)
               and over-pointed targets (everything pointing at one
               flow). -->
          <div
            v-if="flow.next"
            class="mt-auto pt-3 border-t border-default/60 text-xs text-muted leading-relaxed"
          >
            <span class="font-mono uppercase tracking-[0.06em] text-[10px] block mb-1">
              next →
            </span>
            <NuxtLink
              :to="`/docs/${flow.next.slug}`"
              class="font-medium text-default hover:text-primary transition-colors"
            >
              {{ flow.next.slug }}
            </NuxtLink>
            <span class="block mt-0.5 italic">
              {{ flow.next.why }}
            </span>
          </div>
          <div
            v-else
            class="mt-auto pt-3 border-t border-default/60 text-[10px] font-mono uppercase tracking-[0.06em] text-muted"
          >
            no forward link
          </div>
        </div>
      </li>
    </ul>

    <!-- Mobile siblings — listed flat below the primary grid because
         they're variants, not their own stories. Compact rows so the
         page doesn't get a second 3-col grid. -->
    <section
      v-if="mobileSiblings.length > 0"
      class="mt-12"
    >
      <h2 class="font-serif text-xl font-normal tracking-tight mb-3">
        Mobile siblings
      </h2>
      <p class="text-xs text-muted mb-4 max-w-prose">
        Mobile-form-factor captures of the desktop flows above. They
        cover the same user-job through a different surface (the
        Editor drawer instead of the menubar, etc.).
      </p>
      <ul class="space-y-2">
        <li
          v-for="m in mobileSiblings"
          :key="m.slug"
          class="flex items-center justify-between gap-3 px-3 py-2 rounded border border-default bg-default hover:bg-elevated/40 transition-colors"
        >
          <NuxtLink
            :to="`/docs/${m.slug}`"
            class="font-serif text-sm hover:text-primary transition-colors truncate"
          >
            {{ m.title }}
          </NuxtLink>
          <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted truncate">
            {{ m.slug }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>
