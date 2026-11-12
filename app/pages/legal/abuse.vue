<script setup lang="ts">
// Report form (DSA Art.16 notice). Open to everyone: signed-in users
// directly, anonymous visitors behind the invisible ALTCHA bot check
// (shared/config/anonGate.ts) — without the gate on this instance the
// form asks for a sign-in instead. Fields follow Art.16(2): the address of
// the content, why it is illegal or against the rules, name + email
// (optional for child-sexual-abuse reports, Art.16(2)(c)), and the
// good-faith statement. The server sends a confirmation of receipt and,
// later, the decision.
//
// Pre-fill: `?url=` (the "Report" link on a document) or the legacy
// `?docId=`.
import {
  ANON_GATE_RETRYABLE_CODES,
  ANON_GATE_CODES
} from '~~/shared/config/anonGate'
import {
  REPORT_BODY_MAX,
  REPORT_BODY_MIN,
  REPORT_CATEGORIES,
  REPORT_URL_MAX,
  REPORTER_NAME_MAX,
  contactOptionalFor,
  type ReportCategory
} from '~~/shared/config/moderation'

definePageMeta({ middleware: 'legal-surfaces' })
// Public page: no modulepreload / prefetch hints (useLeanResourceHints).
useLeanResourceHints()

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const { loggedIn, user } = useUserSession()
const { anonGate, primaryLoginPath } = useInstanceConfig()
const toast = useToast()

useHead({ title: () => t('legal.abuse.title') })

const categories = computed(() => REPORT_CATEGORIES.map(value => ({
  value,
  label: t(`legal.abuse.category.${value}`)
})))

function prefillFromQuery(): string {
  const url = route.query.url
  if (typeof url === 'string' && url.trim()) return url.trim().slice(0, REPORT_URL_MAX)
  const docId = route.query.docId
  if (typeof docId === 'string' && docId.trim()) return docId.trim().slice(0, REPORT_URL_MAX)
  return ''
}

const contentUrl = ref(prefillFromQuery())
const category = ref<ReportCategory>('illegal_content')
const reportBody = ref('')
const reporterName = ref('')
const reporterEmail = ref('')
const goodFaith = ref(false)
const submitting = ref(false)
const submittedReportId = ref<string | null>(null)
const errorMessage = ref('')

watch(() => route.query, () => {
  const v = prefillFromQuery()
  if (v) contentUrl.value = v
})

// Signed-in reporters: profile name + email as defaults (the server uses
// them too when the fields are left empty).
watch(user, (u) => {
  if (!u) return
  if (!reporterName.value && typeof u.name === 'string') reporterName.value = u.name
  if (!reporterEmail.value && typeof u.email === 'string') reporterEmail.value = u.email
}, { immediate: true })

const needsSignIn = computed(() => !loggedIn.value && !anonGate.value)
const contactOptional = computed(() => contactOptionalFor(category.value))
const botCheck = useAnonBotCheck('abuse-report')
onMounted(() => {
  if (!loggedIn.value && anonGate.value) botCheck.prepare()
})

const canSubmit = computed(() =>
  !needsSignIn.value
  && contentUrl.value.trim().length > 0
  && reportBody.value.trim().length >= REPORT_BODY_MIN
  && (contactOptional.value || (reporterName.value.trim() && reporterEmail.value.trim()))
  && goodFaith.value
  && !submitting.value
)

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    void router.push('/')
  }
}

async function post(altcha: string | null): Promise<{ reportId: string }> {
  return apiFetch('/api/abuse-reports', {
    method: 'post',
    body: {
      contentUrl: contentUrl.value.trim(),
      category: category.value,
      body: reportBody.value.trim(),
      reporterName: reporterName.value.trim(),
      reporterEmail: reporterEmail.value.trim(),
      goodFaith: goodFaith.value,
      locale: locale.value,
      ...(altcha ? { altcha } : {})
    }
  })
}

const { extractError } = useErrorHandler()

/** The refusal's text in the reader's language (from its code); the form's own text when the request never got an answer. */
function messageFor(e: unknown): string {
  const { statusCode, message } = extractError(e)
  return statusCode !== null ? message : t('legal.abuse.errors.generic')
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const anonymous = !loggedIn.value
    let res: { reportId: string }
    try {
      res = await post(anonymous ? await botCheck.take() : null)
    } catch (e) {
      const code = fetchErrorCode(e)
      const retry = anonymous && code !== null
        && (ANON_GATE_RETRYABLE_CODES.includes(code) || code === ANON_GATE_CODES.botCheckRequired)
      if (!retry) throw e
      res = await post(await botCheck.take())
    }
    submittedReportId.value = res.reportId
  } catch (e) {
    errorMessage.value = messageFor(e)
    toast.add({
      title: t('legal.abuse.errors.title'),
      description: errorMessage.value,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    submitting.value = false
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

    <main class="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header class="mb-6">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /legal · abuse
        </p>
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          {{ t('legal.abuse.title') }}
        </h1>
        <p class="mt-3 text-sm text-muted">
          {{ t('legal.abuse.intro') }}
          <i18n-t
            keypath="legal.abuse.policyHint"
            tag="span"
            scope="global"
          >
            <template #policy>
              <NuxtLink
                to="/legal/abuse-policy"
                class="underline"
              >{{ t('legal.abuse.policyLink') }}</NuxtLink>
            </template>
          </i18n-t>
        </p>
      </header>

      <div
        v-if="submittedReportId"
        class="border border-default rounded-lg p-6 text-center"
        data-testid="abuse-report-success"
      >
        <UIcon
          name="i-lucide-check-circle"
          class="size-8 mb-3 mx-auto text-default"
        />
        <h2 class="font-serif text-xl font-normal mb-2">
          {{ t('legal.abuse.submittedTitle') }}
        </h2>
        <p class="text-sm text-muted mb-3">
          {{ reporterEmail.trim() ? t('legal.abuse.submittedBodyEmail') : t('legal.abuse.submittedBody') }}
        </p>
        <p class="font-mono text-xs text-muted">
          {{ t('legal.abuse.reference', { id: submittedReportId }) }}
        </p>
      </div>

      <div
        v-else-if="needsSignIn"
        class="border border-default rounded-lg p-6 text-sm text-muted space-y-3"
        data-testid="abuse-report-signin"
      >
        <p>{{ t('legal.abuse.signInRequired') }}</p>
        <UButton
          v-if="primaryLoginPath"
          :to="primaryLoginPath"
          external
          color="neutral"
        >
          {{ t('legal.abuse.signIn') }}
        </UButton>
      </div>

      <form
        v-else
        class="space-y-5"
        data-testid="abuse-report-form"
        @submit.prevent="onSubmit"
      >
        <div>
          <UFormField
            :label="t('legal.abuse.urlLabel')"
            :description="t('legal.abuse.urlHelp')"
            :ui="{ label: 'text-sm font-normal', description: 'text-xs text-muted mt-1', container: 'mt-2' }"
          >
            <UInput
              id="abuse-url"
              v-model="contentUrl"
              :maxlength="REPORT_URL_MAX"
              placeholder="https://markoto.app/d/…"
              class="w-full font-mono"
              :ui="{ base: 'w-full' }"
              data-testid="abuse-form-url"
            />
          </UFormField>
        </div>
        <div>
          <UFormField
            :label="t('legal.abuse.categoryLabel')"
            :ui="{ label: 'text-sm font-normal', container: 'mt-2' }"
          >
            <USelect
              id="abuse-category"
              v-model="category"
              :items="categories"
              value-key="value"
              class="w-full"
              data-testid="abuse-form-category"
            />
          </UFormField>
        </div>
        <div>
          <UFormField
            :label="t('legal.abuse.bodyLabel')"
            :description="t('legal.abuse.bodyHelp')"
            :ui="{ label: 'text-sm font-normal', description: 'text-xs text-muted mt-1', container: 'mt-2' }"
          >
            <UTextarea
              id="abuse-body"
              v-model="reportBody"
              :placeholder="t('legal.abuse.bodyPlaceholder')"
              :rows="6"
              :maxlength="REPORT_BODY_MAX"
              class="w-full"
              :ui="{ base: 'w-full' }"
              data-testid="abuse-form-body"
            />
          </UFormField>
          <p class="text-xs text-muted mt-1 font-mono">
            {{ reportBody.trim().length }} / {{ REPORT_BODY_MAX }}
          </p>
        </div>

        <fieldset class="grid gap-4 sm:grid-cols-2">
          <legend class="text-sm mb-1 sm:col-span-2">
            {{ t('legal.abuse.contactLegend') }}
            <span class="block text-xs text-muted mt-0.5">
              {{ contactOptional ? t('legal.abuse.contactOptionalCsam') : t('legal.abuse.contactHelp') }}
            </span>
          </legend>
          <div>
            <UFormField
              :label="t('legal.abuse.nameLabel')"
              :ui="{ label: 'text-xs text-muted font-normal', container: 'mt-1' }"
            >
              <UInput
                id="abuse-name"
                v-model="reporterName"
                :maxlength="REPORTER_NAME_MAX"
                autocomplete="name"
                class="w-full"
                :ui="{ base: 'w-full' }"
                data-testid="abuse-form-name"
              />
            </UFormField>
          </div>
          <div>
            <UFormField
              :label="t('legal.abuse.emailLabel')"
              :ui="{ label: 'text-xs text-muted font-normal', container: 'mt-1' }"
            >
              <UInput
                id="abuse-email"
                v-model="reporterEmail"
                type="email"
                autocomplete="email"
                class="w-full"
                :ui="{ base: 'w-full' }"
                data-testid="abuse-form-email"
              />
            </UFormField>
          </div>
        </fieldset>

        <UCheckbox
          v-model="goodFaith"
          :label="t('legal.abuse.goodFaith')"
          data-testid="abuse-form-good-faith"
        />

        <p
          v-if="!loggedIn"
          class="font-mono text-[10.5px] tracking-wide text-muted flex items-center gap-1.5"
          aria-live="polite"
          data-testid="abuse-form-botcheck"
        >
          <UIcon
            :name="botCheck.solving.value ? 'i-lucide-loader' : 'i-lucide-shield-check'"
            class="size-3.5"
            :class="{ 'animate-spin': botCheck.solving.value }"
          />
          {{ botCheck.solving.value ? t('anonGate.botCheckRunning') : t('anonGate.botCheckReady') }}
        </p>

        <p
          v-if="errorMessage"
          class="text-sm text-error"
          role="alert"
        >
          {{ errorMessage }}
        </p>

        <div class="flex justify-end pt-1">
          <UButton
            type="submit"
            color="neutral"
            :loading="submitting"
            :disabled="!canSubmit"
            icon="i-lucide-send"
            data-testid="abuse-form-submit"
          >
            {{ t('legal.abuse.submit') }}
          </UButton>
        </div>
      </form>
    </main>

    <CommonLegalFooter />
  </div>
</template>
