<script setup lang="ts">
// Abuse report form. Login-gated to keep spam manageable; anonymous
// + non-account reports go through the email channel documented
// in /legal/abuse-policy. DSA Article 16 requires the platform to
// accept notices, not that any specific channel be public —
// providing an email contact for anyone + a form for signed-in
// users is a fully-compliant arrangement.
//
// Pre-fill: if the user clicked "Report this document" from
// inside the editor (forthcoming surface), the docId arrives via
// query string `?docId=<id>`. Plain navigation lands on the form
// with the doc field empty + a free-form input.

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { loggedIn } = useUserSession()
const toast = useToast()

useHead({ title: 'Report content · markoto' })

// Anonymous visitors are redirected to the abuse-policy doc which
// describes the email channel they should use instead.
if (import.meta.client && !loggedIn.value) {
  void navigateTo('/legal/abuse-policy')
}

const CATEGORIES = [
  { value: 'illegal_content', label: t('legal.abuse.category.illegal_content') },
  { value: 'copyright', label: t('legal.abuse.category.copyright') },
  { value: 'csam', label: t('legal.abuse.category.csam') },
  { value: 'harassment', label: t('legal.abuse.category.harassment') },
  { value: 'spam', label: t('legal.abuse.category.spam') },
  { value: 'other', label: t('legal.abuse.category.other') }
] as const

type Category = (typeof CATEGORIES)[number]['value']

// docId pre-fill from query string when entering via "Report this
// document". Strip leading `/d/` if a full URL was pasted.
const docIdFromQuery = computed(() => {
  const raw = route.query.docId
  if (typeof raw !== 'string') return ''
  // Accept either a bare doc-id (the canonical form) or a full
  // URL like `/d/abc123` — strip the leading prefix if present.
  const match = raw.match(/\/d\/([^/?]+)/)
  return match ? match[1] : raw
})

const docId = ref(docIdFromQuery.value)
const category = ref<Category>('illegal_content')
const reportBody = ref('')
const submitting = ref(false)
const submittedReportId = ref<string | null>(null)

watch(docIdFromQuery, (v) => { docId.value = v }, { immediate: false })

const canSubmit = computed(() =>
  reportBody.value.trim().length >= 10 && !submitting.value
)

function onClose(): void {
  if (window.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const res = await $fetch<{ reportId: string }>('/api/abuse-reports', {
      method: 'POST',
      body: {
        docId: docId.value.trim() || null,
        category: category.value,
        body: reportBody.value.trim()
      }
    })
    submittedReportId.value = res.reportId
    toast.add({
      title: t('legal.abuse.submittedTitle'),
      description: '',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: 'Could not submit report',
      description: err.data?.message ?? err.message ?? 'Try again',
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
          Read the
          <NuxtLink
            to="/legal/abuse-policy"
            class="underline"
          >
            abuse and illegal-content policy
          </NuxtLink>
          for what we act on and how we triage.
        </p>
      </header>

      <!-- Submitted state. Shows the report id so the user has a
           reference number if they need to follow up. -->
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
          {{ t('legal.abuse.submittedBody') }}
        </p>
        <p class="font-mono text-xs text-muted">
          Reference: {{ submittedReportId }}
        </p>
      </div>

      <!-- Form. -->
      <form
        v-else
        class="space-y-4"
        data-testid="abuse-report-form"
        @submit.prevent="onSubmit"
      >
        <div>
          <label
            for="abuse-doc-id"
            class="block text-sm mb-2"
          >
            {{ t('legal.abuse.docIdLabel') }}
          </label>
          <UInput
            id="abuse-doc-id"
            v-model="docId"
            placeholder="markoto.app/d/abc123… (or leave blank for platform-wide)"
            class="w-full font-mono"
            :ui="{ base: 'w-full' }"
            data-testid="abuse-form-docid"
          />
        </div>
        <div>
          <label
            for="abuse-category"
            class="block text-sm mb-2"
          >
            {{ t('legal.abuse.categoryLabel') }}
          </label>
          <USelect
            id="abuse-category"
            v-model="category"
            :items="CATEGORIES"
            value-key="value"
            class="w-full"
            data-testid="abuse-form-category"
          />
        </div>
        <div>
          <label
            for="abuse-body"
            class="block text-sm mb-2"
          >
            {{ t('legal.abuse.bodyLabel') }}
          </label>
          <UTextarea
            id="abuse-body"
            v-model="reportBody"
            :placeholder="t('legal.abuse.bodyPlaceholder')"
            :rows="6"
            class="w-full"
            :ui="{ base: 'w-full' }"
            data-testid="abuse-form-body"
          />
          <p class="text-xs text-muted mt-1 font-mono">
            {{ reportBody.trim().length }} / 5000
          </p>
        </div>
        <div class="flex justify-end pt-2">
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
