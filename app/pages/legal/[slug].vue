<script setup lang="ts">
// Renderer for the four customer-facing legal documents:
//   /legal/privacy
//   /legal/terms
//   /legal/dpa
//   /legal/abuse-policy
//
// Reads the rendered HTML + metadata from
// `/api/_internal/legal/<slug>?locale=<active>` and surfaces the
// page chrome. Same close-button / max-w-3xl idiom as /pricing and
// /settings/profile so all three feel like overlays on the user's
// context rather than destinations.
//
// Translation banner mirrors the convention in `legal.documentPage.*`
// — when the requested locale falls back to English (because we
// haven't translated yet), we surface that loudly with a link back
// to the authoritative copy.

definePageMeta({ middleware: 'legal-surfaces' })

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()

interface LegalDocResponse {
  slug: string
  title: string
  version: number
  effectiveDate: string
  requestedLocale: string
  actualLocale: string
  isFallback: boolean
  authoritativeLocale: string
  html: string
}

const slug = computed(() => String(route.params.slug ?? ''))

// SSR-friendly fetch: useFetch hits the internal endpoint with the
// active i18n locale. The page renders the doc via `v-html` since
// the markdown comes back already rendered + sanitised by the
// server (markdown-it with html: false).
const { data, error, pending, refresh } = await useFetch<LegalDocResponse>(
  () => `/api/_internal/legal/${slug.value}`,
  {
    query: computed(() => ({ locale: locale.value })),
    // Re-fetch when the user switches language while reading.
    watch: [locale]
  }
)

useHead(() => ({
  title: data.value
    ? `${data.value.title} · markoto`
    : `Legal · markoto`
}))

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

function viewAuthoritative(): void {
  // Force English by appending ?locale=en. The same query-string
  // path the i18n switcher uses elsewhere; refresh re-fetches.
  router.replace({ query: { ...route.query, locale: data.value?.authoritativeLocale ?? 'en' } })
  void refresh()
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale.value, {
      year: 'numeric', month: 'long', day: 'numeric'
    })
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
    <CommonHomeLink />
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="md"
      class="absolute top-4 right-4 z-10"
      :aria-label="t('pricing.close')"
      @click="onClose"
    />

    <main class="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <!-- Loading + error states. Errors surface a clear 404 message;
           anything else is a 500-shaped fallback. -->
      <div
        v-if="pending"
        class="text-sm text-muted py-12 text-center"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="size-5 animate-spin mb-3 mx-auto"
        />
        Loading…
      </div>
      <div
        v-else-if="error || !data"
        class="text-sm text-rose-700 dark:text-rose-300 py-12 text-center"
      >
        <p class="font-serif text-2xl mb-2">
          Document not found
        </p>
        <p>The legal document at /legal/{{ slug }} doesn't exist.</p>
      </div>

      <article
        v-else
        :data-testid="`legal-doc-${data.slug}`"
      >
        <!-- Eyebrow + version chip + effective date in mono. -->
        <header class="mb-6">
          <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
            /legal · {{ t('legal.documentPage.version', { version: data.version }) }} · {{ t('legal.documentPage.lastUpdated', { date: fmtDate(data.effectiveDate) }) }}
          </p>
        </header>

        <!-- Translation-fallback banner. Shows when the user's locale
             isn't translated yet and we fell back to English. The link
             is informational — they're already reading English. -->
        <UAlert
          v-if="data.isFallback"
          color="neutral"
          variant="soft"
          icon="i-lucide-globe"
          class="mb-6"
          :title="t('legal.documentPage.translationNoticeTitle')"
          :description="t('legal.documentPage.missingLocale')"
        />
        <!-- Convenience banner when reading a non-authoritative
             translation — even when we DO have a translation,
             the English text legally prevails. -->
        <UAlert
          v-else-if="data.actualLocale !== data.authoritativeLocale"
          color="neutral"
          variant="soft"
          icon="i-lucide-globe"
          class="mb-6"
          :title="t('legal.documentPage.translationNoticeTitle')"
          :description="t('legal.documentPage.translationNoticeBody')"
        >
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              @click="viewAuthoritative"
            >
              {{ t('legal.documentPage.viewAuthoritative') }}
            </UButton>
          </template>
        </UAlert>

        <!-- Body. Server-rendered markdown via markdown-it (html:
             false). The .legal-doc-prose class gives us editorial
             body type without dragging in the Tailwind Typography
             plugin (already pulled in elsewhere via @nuxt/ui's
             prose styles, but those are tuned for /docs and would
             be over-styled here). -->
        <!-- Server-side rendered + DOMPurify-sanitised in
             /api/_internal/legal/:slug. The endpoint is the only
             producer; the v-html sink is intentional. -->
        <!-- eslint-disable vue/no-v-html -->
        <div
          class="legal-doc-prose"
          v-html="data.html"
        />
        <!-- eslint-enable vue/no-v-html -->
      </article>
    </main>

    <CommonLegalFooter />
  </div>
</template>

<style scoped>
.legal-doc-prose {
  --doc-line-height: 1.65;
  font-size: 15px;
  line-height: var(--doc-line-height);
  color: var(--ui-text);
}
.legal-doc-prose :deep(h1) {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: clamp(1.875rem, 4vw, 2.5rem);
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin: 0 0 1.5rem;
}
.legal-doc-prose :deep(h2) {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 1.375rem;
  letter-spacing: -0.01em;
  margin: 2.5rem 0 0.75rem;
}
.legal-doc-prose :deep(h3) {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 1.125rem;
  margin: 1.75rem 0 0.5rem;
}
.legal-doc-prose :deep(p) {
  margin: 0 0 1rem;
}
.legal-doc-prose :deep(ul),
.legal-doc-prose :deep(ol) {
  margin: 0 0 1rem;
  padding-left: 1.5rem;
}
.legal-doc-prose :deep(ul) {
  list-style: disc;
}
.legal-doc-prose :deep(ol) {
  list-style: decimal;
}
.legal-doc-prose :deep(li) {
  margin: 0.25rem 0;
}
.legal-doc-prose :deep(a) {
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--ui-text) 30%, transparent);
  text-underline-offset: 2px;
}
.legal-doc-prose :deep(a:hover) {
  text-decoration-color: var(--ui-text);
}
.legal-doc-prose :deep(blockquote) {
  border-left: 3px solid color-mix(in srgb, var(--ui-text) 25%, transparent);
  padding-left: 1rem;
  margin: 0 0 1rem;
  color: var(--ui-text-muted);
  font-style: italic;
}
.legal-doc-prose :deep(strong) {
  font-weight: 500;
}
.legal-doc-prose :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0.1em 0.3em;
  background: color-mix(in srgb, var(--ui-text) 8%, transparent);
  border-radius: 3px;
}
.legal-doc-prose :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0 0 1.25rem;
  font-size: 0.95em;
}
.legal-doc-prose :deep(th),
.legal-doc-prose :deep(td) {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-text) 12%, transparent);
}
.legal-doc-prose :deep(th) {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.legal-doc-prose :deep(hr) {
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--ui-text) 12%, transparent);
  margin: 2.5rem 0;
}
</style>
