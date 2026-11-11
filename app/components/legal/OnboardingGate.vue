<script setup lang="ts">
// Onboarding gate. Blocks the app on first login (or after a material
// privacy-policy / ToS bump) until the user confirms they're at least 16
// (GDPR Article 8) and accepts the current Privacy Policy + Terms of Service.
//
// DPA acceptance is workspace-owner only and handled at workspace creation,
// not here. The modal is blocking: the only way out besides accepting is
// "Sign out". Anonymous users never see it (no row to attach acceptance to).
// Mounted globally via AppOverlays.

const { t, locale } = useI18n()
const route = useRoute()
const { loggedIn } = useUserSession()
const { logout } = useLogout()
const { status, refresh } = useAccountStatus()
const toast = useToast()
const { extractError } = useErrorHandler()

const open = ref(false)
const submitting = ref(false)
const ageChecked = ref(false)
const privacyChecked = ref(false)
const tosChecked = ref(false)

// Routes where the gate is suppressed: the legal documents are what the user
// is asked to accept, so blocking them would be a chicken-and-egg trap. The
// gate re-arms on navigating off /legal/*.
function isExemptRoute(path: string): boolean {
  return path.startsWith('/legal/')
}

// Gate trigger: (a) logged in, (b) at least one of age / privacy
// / ToS needs attention, AND (c) NOT on a /legal/* page right now.
// DPA is deliberately NOT in the gate — workspace-owner only.
const needsGate = computed(() => {
  if (!loggedIn.value || !status.value) return false
  if (isExemptRoute(route.path)) return false
  return Boolean(
    status.value.age?.confirmationRequired
    || status.value.policy?.privacy?.acceptanceRequired
    || status.value.policy?.tos?.acceptanceRequired
  )
})

// Two-way binding: open follows needsGate. Re-evaluates when the
// user navigates onto/off /legal/* so the modal closes the moment
// they click "Privacy Policy" and re-opens when they navigate back.
watch(needsGate, (v) => {
  open.value = v
}, { immediate: true })

const ageRequired = computed(() => status.value?.age?.confirmationRequired === true)
const privacyRequired = computed(() => status.value?.policy?.privacy?.acceptanceRequired === true)
const tosRequired = computed(() => status.value?.policy?.tos?.acceptanceRequired === true)

const canSubmit = computed(() => {
  if (ageRequired.value && !ageChecked.value) return false
  if (privacyRequired.value && !privacyChecked.value) return false
  if (tosRequired.value && !tosChecked.value) return false
  return true
})

const privacyVersion = computed(() => status.value?.policy?.privacy?.currentVersion ?? 0)
const tosVersion = computed(() => status.value?.policy?.tos?.currentVersion ?? 0)

async function onSubmit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    await apiFetch('/api/user/onboarding-accept', {
      method: 'post',
      body: {
        ageConfirmed: ageChecked.value || !ageRequired.value,
        privacyVersion: privacyVersion.value,
        tosVersion: tosVersion.value,
        locale: locale.value
      }
    })
    await refresh()
    open.value = false
    toast.add({
      title: 'Welcome to markoto',
      description: '',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    const err = extractError(e)
    if (err.code === 'onboarding/privacy-version-stale' || err.code === 'onboarding/tos-version-stale') {
      // The user opened the modal, we bumped a version mid-read;
      // refetch and re-prompt. The watcher on `needsGate` re-opens.
      await refresh()
      privacyChecked.value = false
      tosChecked.value = false
      toast.add({
        title: 'Document updated — please review again',
        description: err.message,
        icon: 'i-lucide-refresh-cw',
        color: 'neutral'
      })
    } else {
      toast.add({
        title: 'Could not record your acceptance',
        description: err.message,
        icon: 'i-lucide-alert-circle',
        color: 'error'
      })
    }
  } finally {
    submitting.value = false
  }
}

async function onSignOut(): Promise<void> {
  // The "I'd rather sign out than accept" escape hatch. Same
  // logout pipeline as the avatar dropdown.
  open.value = false
  await logout()
}
</script>

<template>
  <UModal
    v-model:open="open"
    :dismissible="false"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #content>
      <div
        class="flex flex-col p-6 max-h-[85vh]"
        data-testid="onboarding-gate-modal"
      >
        <header class="mb-4 shrink-0">
          <h2 class="font-serif text-2xl font-normal tracking-tight mb-1">
            Welcome to markoto
          </h2>
          <p class="text-sm text-muted">
            Before you start writing, we need a quick acknowledgement
            on the items below. You only see this once, or after we
            materially update one of the documents.
          </p>
        </header>

        <div class="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
          <!-- Age gate — Article 8 GDPR. -->
          <section
            v-if="ageRequired"
            class="border border-default rounded-lg p-4"
            data-testid="onboarding-age-section"
          >
            <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              {{ t('legal.ageGate.title') }}
            </h3>
            <p class="text-sm text-muted mb-3">
              {{ t('legal.ageGate.body') }}
            </p>
            <UCheckbox
              v-model="ageChecked"
              :label="t('legal.ageGate.checkbox')"
              data-testid="onboarding-age-checkbox"
            />
          </section>

          <!-- Privacy + ToS acceptance. -->
          <section
            v-if="privacyRequired || tosRequired"
            class="border border-default rounded-lg p-4"
            data-testid="onboarding-policies-section"
          >
            <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
              Documents to accept
            </h3>
            <p class="text-sm text-muted mb-3">
              We've published these in plain language — open each in a
              new tab to read in full. Your acceptance is recorded with
              the version you read so we can prove what you saw.
            </p>
            <div class="space-y-2">
              <UCheckbox
                v-if="privacyRequired"
                v-model="privacyChecked"
                data-testid="onboarding-privacy-checkbox"
              >
                <template #label>
                  <span>I have read and accept the </span>
                  <NuxtLink
                    to="/legal/privacy"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                  >
                    Privacy Policy
                  </NuxtLink>
                  <span class="font-mono text-[11px] text-muted ml-1">
                    v{{ privacyVersion }}
                  </span>
                </template>
              </UCheckbox>
              <UCheckbox
                v-if="tosRequired"
                v-model="tosChecked"
                data-testid="onboarding-tos-checkbox"
              >
                <template #label>
                  <span>I have read and accept the </span>
                  <NuxtLink
                    to="/legal/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                  >
                    Terms of Service
                  </NuxtLink>
                  <span class="font-mono text-[11px] text-muted ml-1">
                    v{{ tosVersion }}
                  </span>
                </template>
              </UCheckbox>
            </div>
          </section>
        </div>

        <!-- CTA row. Stays visible at the bottom of the modal. -->
        <div class="mt-6 pt-4 border-t border-default shrink-0 flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
          <UButton
            variant="ghost"
            color="neutral"
            :disabled="submitting"
            block
            class="sm:!w-auto"
            @click="onSignOut"
          >
            Sign out
          </UButton>
          <UButton
            color="neutral"
            :loading="submitting"
            :disabled="!canSubmit"
            block
            class="sm:!w-auto"
            data-testid="onboarding-submit"
            @click="onSubmit"
          >
            Continue to markoto
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
