<script setup lang="ts">
// Public sub-processor list. GDPR Article 13(1)(e) disclosure of
// recipients of personal data, plus the per-recipient transfer
// mechanism (DPF / SCCs / intra-EU). One row per sub-processor;
// the registry in `server/legal/subProcessors.ts` is the source
// of truth and this page renders whatever it contains — adding a
// new sub-processor is one TypeScript edit, no template change.
import { LEGAL_PAGE_DESCRIPTIONS } from '~~/shared/seo/meta'
import { pageBreadcrumbs } from '~~/shared/seo/breadcrumbs'
import type { ApiResponse } from '~/utils/api/client'
import { PRIVACY_EFFECTIVE_DATE } from '~~/shared/legal/versions'

type SubProcessor = ApiResponse<'/api/_internal/sub-processors', 'get'>[number]

const router = useRouter()
const { t } = useI18n()

const { data: subProcessors, pending } = await useFetch(
  '/api/_internal/sub-processors'
)

const SEO_TITLE = t('legal.footer.subProcessors')
const SEO_DESCRIPTION = LEGAL_PAGE_DESCRIPTIONS['sub-processors'] ?? ''
const { imageUrl } = useMarketingSeo({ title: SEO_TITLE, description: SEO_DESCRIPTION, imageGroup: 'default' })
usePageStructuredData(() => ({
  name: SEO_TITLE,
  description: SEO_DESCRIPTION,
  // The list is part of the privacy policy and changes with it.
  dateModified: PRIVACY_EFFECTIVE_DATE,
  image: imageUrl.value,
  breadcrumbs: pageBreadcrumbs('/legal/sub-processors', SEO_TITLE)
}))

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    void router.push('/')
  }
}

// Human-readable labels for the structured location + transfer values; the
// marketing sub-processor table shares the same texts.
const locationLabel = (location: SubProcessor['location']): string => t(`marketing.subProcessors.location.${location}`)
const transferLabel = (mechanism: SubProcessor['transferMechanism']): string => t(`marketing.subProcessors.transfer.${mechanism}`)
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

    <main class="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header class="mb-8">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /legal · sub-processors
        </p>
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          {{ t('legal.footer.subProcessors') }}
        </h1>
        <p class="mt-3 text-sm text-muted">
          {{ t('legal.subProcessors.intro') }}
        </p>
      </header>

      <div
        v-if="pending"
        class="text-sm text-muted py-12 text-center"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="size-5 animate-spin mb-3 mx-auto"
        />
        {{ t('common.loading') }}
      </div>

      <!-- One card per sub-processor. A table would pack tighter on
           desktop, but cards survive mobile better and let each row
           breathe — there's no value in a 50-row dense table here;
           we have <10 sub-processors and add one per launch. -->
      <ul
        v-else-if="subProcessors"
        class="space-y-3"
        data-testid="sub-processors-list"
      >
        <li
          v-for="sp in subProcessors"
          :key="sp.id"
          class="border border-default rounded-lg px-4 py-4"
          :data-testid="`sub-processor-${sp.id}`"
        >
          <div class="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-3 mb-2">
            <h2 class="font-serif text-lg font-normal tracking-tight">
              {{ sp.name }}
            </h2>
            <div class="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted shrink-0">
              <span>{{ locationLabel(sp.location) }}</span>
              <span
                v-if="sp.dpfCertified"
                class="px-1.5 py-0.5 rounded border border-default"
                :title="t('legal.subProcessors.dpfCertified')"
              >
                {{ t('legal.subProcessors.dpf') }}
              </span>
            </div>
          </div>

          <p class="text-sm mb-3">
            {{ sp.purpose }}
          </p>

          <dl class="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            <dt class="font-mono uppercase tracking-wider text-muted">
              {{ t('legal.subProcessors.transfer') }}
            </dt>
            <dd class="font-mono">
              {{ transferLabel(sp.transferMechanism) }}
            </dd>

            <dt class="font-mono uppercase tracking-wider text-muted">
              {{ t('legal.footer.privacy') }}
            </dt>
            <dd>
              <a
                :href="sp.privacyPolicyUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:underline [overflow-wrap:anywhere]"
              >{{ sp.privacyPolicyUrl }}</a>
            </dd>

            <template v-if="sp.dpaUrl">
              <dt class="font-mono uppercase tracking-wider text-muted">
                {{ t('legal.footer.dpaShort') }}
              </dt>
              <dd>
                <a
                  :href="sp.dpaUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hover:underline [overflow-wrap:anywhere]"
                >{{ sp.dpaUrl }}</a>
              </dd>
            </template>
          </dl>
        </li>
      </ul>
    </main>

    <CommonLegalFooter />
  </div>
</template>
