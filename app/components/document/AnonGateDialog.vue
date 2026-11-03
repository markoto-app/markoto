<script setup lang="ts">
// Accept-terms step before the first anonymous document in this browser
// (shared/config/anonGate.ts). Mounted once in CommonAppOverlays and
// opened through `useAnonTermsPrompt().ask()` by `useAnonDocCreate()`.
// The bot check (ALTCHA proof of work) runs invisibly in the background
// while the visitor reads this; the server re-checks everything.
//
// Stacking: it opens ON TOP of the new-document dialog, whose teleported
// overlay can come later in the DOM, so overlay + content carry their own
// z-index (also above the consent bar's z-60).
import { ANON_GATE_MIN_AGE } from '~~/shared/config/anonGate'

const { t } = useI18n()
const { state, answer } = useAnonTermsPrompt()
const { solving } = useAnonDocCreate()
const { anonDocTtlDays, primaryLoginPath } = useInstanceConfig()

const accepted = ref(false)

watch(() => state.value.open, (open) => {
  if (open) accepted.value = false
})

function onOpenChange(open: boolean): void {
  if (!open) answer(false)
}

function onConfirm(): void {
  if (!accepted.value) return
  answer(true)
}
</script>

<template>
  <UModal
    :open="state.open"
    :ui="{ overlay: 'z-[70]', content: 'max-w-lg z-[71]' }"
    @update:open="onOpenChange"
  >
    <template #content>
      <form
        class="flex flex-col gap-4 p-5 sm:p-6"
        data-testid="anon-gate-dialog"
        @submit.prevent="onConfirm"
      >
        <header>
          <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
            {{ t('anonGate.eyebrow') }}
          </p>
          <h2 class="font-serif text-2xl font-normal tracking-tight">
            {{ t('anonGate.title') }}
          </h2>
        </header>

        <ul class="text-sm text-muted space-y-1.5 list-disc ps-5">
          <li>{{ t('anonGate.pointPublic') }}</li>
          <li v-if="anonDocTtlDays > 0">
            {{ t('anonGate.pointRetention', { days: anonDocTtlDays }) }}
          </li>
          <li>{{ t('anonGate.pointRules') }}</li>
        </ul>

        <UCheckbox
          v-model="accepted"
          data-testid="anon-gate-accept"
        >
          <template #label>
            <i18n-t
              keypath="anonGate.accept"
              tag="span"
              scope="global"
            >
              <template #terms>
                <NuxtLink
                  to="/legal/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline"
                >{{ t('anonGate.termsLink') }}</NuxtLink>
              </template>
              <template #age>
                {{ ANON_GATE_MIN_AGE }}
              </template>
            </i18n-t>
          </template>
        </UCheckbox>

        <p class="text-xs text-muted">
          <i18n-t
            keypath="anonGate.privacyNote"
            tag="span"
            scope="global"
          >
            <template #privacy>
              <NuxtLink
                to="/legal/privacy"
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
              >{{ t('anonGate.privacyLink') }}</NuxtLink>
            </template>
          </i18n-t>
        </p>

        <p
          class="font-mono text-[10.5px] tracking-wide text-muted flex items-center gap-1.5"
          data-testid="anon-gate-botcheck"
          aria-live="polite"
        >
          <UIcon
            :name="solving ? 'i-lucide-loader' : 'i-lucide-shield-check'"
            class="size-3.5"
            :class="{ 'animate-spin': solving }"
          />
          {{ solving ? t('anonGate.botCheckRunning') : t('anonGate.botCheckReady') }}
        </p>

        <footer class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
          <NuxtLink
            v-if="primaryLoginPath"
            :to="primaryLoginPath"
            external
            class="text-sm text-muted underline text-center sm:text-start"
          >
            {{ t('anonGate.signInInstead') }}
          </NuxtLink>
          <span v-else />
          <div class="flex flex-col-reverse sm:flex-row gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              block
              class="sm:w-auto"
              data-testid="anon-gate-cancel"
              @click="answer(false)"
            >
              {{ t('anonGate.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="neutral"
              block
              class="sm:w-auto"
              :disabled="!accepted"
              data-testid="anon-gate-continue"
            >
              {{ t('anonGate.continue') }}
            </UButton>
          </div>
        </footer>
      </form>
    </template>
  </UModal>
</template>
