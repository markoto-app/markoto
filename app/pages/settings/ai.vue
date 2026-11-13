<script setup lang="ts">
// "AI provider" settings: bring your own key. One card per
// capability (chat / image / transcription). Each shows where the
// capability comes from right now (own key → instance default → none)
// and lets the user connect their own OpenAI-compatible provider.
//
// Modal-style page like /settings/profile: close button returns to the
// previous route; auth-gated client-side, endpoints are session-only.

import type { AiCapability, AiProviderConfigView } from '~~/shared/ai/providers'
import { useAiProvidersQuery, useSetAiModelTier } from '~/queries/ai'

const router = useRouter()
const { t } = useI18n()
const toast = useToast()
const { loggedIn } = useUserSession()
// Login starts at the first configured OAuth provider ('/' when none).
const { primaryLoginPath } = useInstanceConfig()

useHead({ title: () => t('aiProvider.title') })

if (import.meta.client && !loggedIn.value) {
  globalThis.location.href = primaryLoginPath.value ?? '/'
}

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    void router.push('/')
  }
}

const providers = useAiProvidersQuery()
const data = computed(() => providers.data.value ?? null)
const loading = computed(() => providers.isLoading.value)
watch(() => providers.error.value, (e) => {
  if (e) toast.add({ title: t('aiProvider.errors.loadFailed'), color: 'error', icon: 'i-lucide-alert-circle' })
})

// Fast / Strong platform chat model. The mutation re-reads the providers
// and the availability it changes.
const setModelTier = useSetAiModelTier()
const savingTier = computed(() => setModelTier.isLoading.value)
async function saveTier(tier: 'fast' | 'strong'): Promise<void> {
  try {
    await setModelTier.mutateAsync(tier)
  } catch {
    toast.add({ title: t('aiProvider.modelTier.saveFailed'), color: 'error', icon: 'i-lucide-alert-circle' })
  }
}

const CAPABILITIES: AiCapability[] = ['chat', 'image', 'transcription']

function configFor(capability: AiCapability): AiProviderConfigView | null {
  return data.value?.providers.find(p => p.capability === capability) ?? null
}

// The instance has a platform-paid chat default AND the user's key draws
// on the shared monthly free pool (hosted SaaS): say what they get
// without a key of their own.
const { state: aiCredits } = useAiCredits()
const freeAllowancePooled = computed(() => data.value?.instanceDefaults.chat === true && aiCredits.value?.freeAllowance?.pooled === true)

const allowlistText = computed(() => {
  const list = data.value?.policy.allowedBaseUrls ?? []
  return list.map(u => u.replace(/^https?:\/\//, '')).join(', ')
})
</script>

<template>
  <div class="min-h-[100dvh] bg-muted text-default relative">
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

    <main
      class="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12"
      data-testid="ai-provider-settings"
    >
      <header class="mb-8">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /settings/ai
        </p>
        <h1 class="font-serif text-2xl sm:text-4xl font-normal tracking-tight mb-3">
          {{ t('aiProvider.title') }}
        </h1>
        <p class="text-sm text-muted mb-2">
          {{ t('aiProvider.intro') }}
        </p>
        <p class="text-sm text-muted mb-2">
          {{ t('aiProvider.privacyNote') }}
        </p>
        <p class="text-sm text-muted">
          {{ t('aiProvider.platformNote') }}
        </p>
        <p
          v-if="freeAllowancePooled"
          class="text-sm text-muted mt-2"
          data-testid="ai-provider-free-allowance-note"
        >
          {{ t('aiProvider.freeAllowanceNote') }}
        </p>
      </header>

      <p
        v-if="allowlistText"
        class="text-xs text-muted font-mono mb-6"
        data-testid="ai-provider-allowlist"
      >
        {{ t('aiProvider.allowedProvidersNote', { list: allowlistText }) }}
      </p>
      <p
        v-else-if="data?.policy.allowPrivate"
        class="text-xs text-muted mb-6"
      >
        {{ t('aiProvider.privateAllowedNote') }}
      </p>

      <div
        v-if="loading && !data"
        class="text-sm text-muted"
      >
        {{ t('aiProvider.loading') }}
      </div>

      <div
        v-if="data"
        class="space-y-6"
      >
        <!-- Platform chat model: Fast / Strong. Only where the
             operator offers a strong model and chat runs on the platform. -->
        <section
          v-if="data.availability.chat.modelTier?.strongAvailable"
          class="border border-default rounded-lg px-4 py-4 space-y-3"
          data-testid="ai-model-tier"
        >
          <h2 class="font-serif text-lg font-normal tracking-tight">
            {{ t('aiProvider.modelTier.title') }}
          </h2>
          <p class="text-sm text-muted">
            {{ t('aiProvider.modelTier.description') }}
          </p>
          <URadioGroup
            :model-value="data.availability.chat.modelTier.selected"
            :items="[
              { label: t('aiProvider.modelTier.fast'), description: t('aiProvider.modelTier.fastHint'), value: 'fast' },
              { label: t('aiProvider.modelTier.strong'), description: t('aiProvider.modelTier.strongHint'), value: 'strong', disabled: data.availability.chat.modelTier.strongLocked }
            ]"
            :disabled="savingTier"
            data-testid="ai-model-tier-radio"
            @update:model-value="(v) => saveTier(v as 'fast' | 'strong')"
          />
          <p
            v-if="data.availability.chat.modelTier.strongLocked"
            class="text-xs text-muted"
            data-testid="ai-model-tier-locked"
          >
            {{ t('aiProvider.modelTier.locked') }}
          </p>
        </section>

        <SettingsAiProviderCard
          v-for="capability in CAPABILITIES"
          :key="capability"
          :capability="capability"
          :config="configFor(capability)"
          :status="data.availability[capability]"
          :presets="data.presets"
        />
      </div>
    </main>
  </div>
</template>
