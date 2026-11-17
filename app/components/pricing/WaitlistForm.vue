<script setup lang="ts">
import { ANALYTICS_EVENTS } from '~~/shared/analytics/events'

// Paid-plans waitlist sign-up (hosted free-only SaaS). Rendered by
// /pricing only while `plansComingSoon` is true.
//
// Consent rules (GDPR Art.4(11) + 7, Swiss FADP): the checkbox starts
// UNTICKED, the submit button stays disabled until it's ticked, and the
// server rejects any request without `consent: true`. The server always
// answers the same 202 for a well-formed request, so the success state
// is worded conditionally ("if the address can receive email…"), we
// never confirm whether an address is already on the list.

const { t, locale } = useI18n()
const { extractError } = useErrorHandler()

const email = ref('')
const consent = ref(false)
const submitting = ref(false)
const submitted = ref(false)
const errorMessage = ref<string | null>(null)

const analytics = useAnalytics()
// The ad click id travels only with the sign-up itself (docs/operations-analytics.md).
function clickIdField() {
  const clickId = analytics.clickId()
  return clickId ? { attribution: clickId } : {}
}

const canSubmit = computed(() => consent.value && email.value.trim().length > 0 && !submitting.value)

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  errorMessage.value = null
  try {
    await apiFetch('/api/waitlist', {
      method: 'post',
      body: { email: email.value.trim(), locale: locale.value, consent: consent.value, ...clickIdField() }
    })
    submitted.value = true
    analytics.track(ANALYTICS_EVENTS.waitlistSubmitted, {})
  } catch (e) {
    errorMessage.value = extractError(e).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section
    class="border border-default rounded-lg p-4 sm:p-6 bg-default"
    data-testid="waitlist-section"
  >
    <h2 class="font-serif text-2xl font-normal tracking-tight">
      {{ t('waitlist.title') }}
    </h2>
    <p class="mt-1 text-sm text-muted">
      {{ t('waitlist.description') }}
    </p>

    <div
      v-if="submitted"
      class="mt-4 rounded-lg border border-default bg-muted px-4 py-3"
      data-testid="waitlist-success"
      role="status"
    >
      <p class="text-sm font-medium">
        {{ t('waitlist.successTitle') }}
      </p>
      <p class="mt-1 text-sm text-muted">
        {{ t('waitlist.successBody') }}
      </p>
    </div>

    <form
      v-else
      class="mt-4 space-y-3"
      novalidate
      data-testid="waitlist-form"
      @submit.prevent="onSubmit"
    >
      <UFormField
        :label="t('waitlist.emailLabel')"
        name="waitlist-email"
      >
        <UInput
          v-model="email"
          type="email"
          autocomplete="email"
          :placeholder="t('waitlist.emailPlaceholder')"
          class="w-full"
          data-testid="waitlist-email"
        />
      </UFormField>

      <UCheckbox
        v-model="consent"
        data-testid="waitlist-consent"
      >
        <template #label>
          <span>{{ t('waitlist.consentLabel') }}</span>
          <NuxtLink
            to="/legal/privacy"
            target="_blank"
            rel="noopener noreferrer"
            class="underline ml-1"
          >
            {{ t('waitlist.privacyLink') }}
          </NuxtLink>
        </template>
      </UCheckbox>

      <p
        v-if="errorMessage"
        class="text-sm text-error"
        role="alert"
        data-testid="waitlist-error"
      >
        {{ errorMessage }}
      </p>

      <UButton
        type="submit"
        color="neutral"
        :disabled="!canSubmit"
        :loading="submitting"
        data-testid="waitlist-submit"
      >
        {{ t('waitlist.submit') }}
      </UButton>
    </form>
  </section>
</template>
