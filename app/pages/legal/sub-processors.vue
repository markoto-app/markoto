<script setup lang="ts">
// Public sub-processor list. GDPR Article 13(1)(e) disclosure of
// recipients of personal data, plus the per-recipient transfer
// mechanism (DPF / SCCs / intra-EU). One row per sub-processor;
// the registry in `server/legal/subProcessors.ts` is the source
// of truth and this page renders whatever it contains — adding a
// new sub-processor is one TypeScript edit, no template change.

interface SubProcessor {
  id: string
  name: string
  purpose: string
  location: 'eu' | 'us' | 'global'
  transferMechanism: 'intra_eu' | 'dpf' | 'sccs' | 'dpf_with_sccs_fallback'
  dpfCertified: boolean
  privacyPolicyUrl: string
  dpaUrl: string | null
}

definePageMeta({ middleware: 'legal-surfaces' })

const router = useRouter()
const { t } = useI18n()

const { data: subProcessors, pending } = await useFetch<SubProcessor[]>(
  '/api/_internal/sub-processors'
)

useHead({ title: 'Sub-processors' })

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

// Human-readable labels for the structured location + transfer
// values. Keep these inline rather than in i18n — the values are
// regulatory terms with established translations and any localised
// version would have to mirror EU regulation language anyway.
const LOCATION_LABEL: Record<SubProcessor['location'], string> = {
  eu: 'European Union',
  us: 'United States',
  global: 'Global'
}
const TRANSFER_LABEL: Record<SubProcessor['transferMechanism'], string> = {
  intra_eu: 'Intra-EU (no transfer)',
  dpf: 'EU-US Data Privacy Framework',
  sccs: 'Standard Contractual Clauses',
  dpf_with_sccs_fallback: 'EU-US DPF (SCCs as fallback)'
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

    <main class="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header class="mb-8">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /legal · sub-processors
        </p>
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          Sub-processors
        </h1>
        <p class="mt-3 text-sm text-muted">
          The third parties markoto engages to process personal data on
          our behalf, with the location, transfer mechanism, and public
          links for each. Required disclosure under GDPR Article 13(1)(e).
          We notify workspace-owner customers at least 30 days in
          advance of any new sub-processor.
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
        Loading…
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
              <span>{{ LOCATION_LABEL[sp.location] }}</span>
              <span
                v-if="sp.dpfCertified"
                class="px-1.5 py-0.5 rounded border border-default"
                title="EU-US Data Privacy Framework certified"
              >
                DPF
              </span>
            </div>
          </div>

          <p class="text-sm mb-3">
            {{ sp.purpose }}
          </p>

          <dl class="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <dt class="font-mono uppercase tracking-wider text-muted">
              Transfer
            </dt>
            <dd class="font-mono">
              {{ TRANSFER_LABEL[sp.transferMechanism] }}
            </dd>

            <dt class="font-mono uppercase tracking-wider text-muted">
              Privacy
            </dt>
            <dd>
              <a
                :href="sp.privacyPolicyUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:underline"
              >{{ sp.privacyPolicyUrl }}</a>
            </dd>

            <template v-if="sp.dpaUrl">
              <dt class="font-mono uppercase tracking-wider text-muted">
                DPA
              </dt>
              <dd>
                <a
                  :href="sp.dpaUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hover:underline"
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
