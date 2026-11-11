<script setup lang="ts">
// Landing card for the two links in the waitlist email
// (/waitlist/confirm and /waitlist/unsubscribe). The token travels in
// the query string but is only sent to the API on an explicit button
// click — never on page load — so mail-security scanners that prefetch
// links can neither confirm a sign-up nor unsubscribe someone.

const props = defineProps<{
  action: 'confirm' | 'unsubscribe'
}>()

const { t } = useI18n()
const route = useRoute()
const { extractError } = useErrorHandler()

const token = computed(() => {
  const raw = route.query.token
  return typeof raw === 'string' && raw.length > 0 ? raw : null
})

const state = ref<'idle' | 'working' | 'done' | 'error'>('idle')
const errorMessage = ref<string | null>(null)

async function onAct(): Promise<void> {
  if (!token.value || state.value === 'working') return
  state.value = 'working'
  errorMessage.value = null
  try {
    const body = { token: token.value }
    if (props.action === 'confirm') await apiFetch('/api/waitlist/confirm', { method: 'post', body })
    else await apiFetch('/api/waitlist/unsubscribe', { method: 'post', body })
    state.value = 'done'
  } catch (e) {
    errorMessage.value = extractError(e).message
    state.value = 'error'
  }
}

const copyKey = computed(() => `waitlist.${props.action}`)

useHead({
  title: () => t(`${copyKey.value}.title`),
  // Single-use links: keep them out of search indexes.
  meta: [{ name: 'robots', content: 'noindex' }]
})
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
    <CommonHomeLink />
    <main class="max-w-md mx-auto px-4 py-16 sm:py-24">
      <section
        class="border border-default rounded-lg p-6 bg-default"
        :data-testid="`waitlist-${action}-card`"
      >
        <template v-if="state === 'done'">
          <h1 class="font-serif text-2xl font-normal tracking-tight">
            {{ t(`${copyKey}.successTitle`) }}
          </h1>
          <p
            class="mt-2 text-sm text-muted"
            :data-testid="`waitlist-${action}-success`"
          >
            {{ t(`${copyKey}.successBody`) }}
          </p>
          <UButton
            class="mt-6"
            color="neutral"
            variant="subtle"
            to="/"
          >
            {{ t('waitlist.backHome') }}
          </UButton>
        </template>

        <template v-else>
          <h1 class="font-serif text-2xl font-normal tracking-tight">
            {{ t(`${copyKey}.title`) }}
          </h1>
          <p
            v-if="!token"
            class="mt-2 text-sm text-muted"
            role="alert"
          >
            {{ t('waitlist.missingToken') }}
          </p>
          <template v-else>
            <p class="mt-2 text-sm text-muted">
              {{ t(`${copyKey}.body`) }}
            </p>
            <p
              v-if="errorMessage"
              class="mt-3 text-sm text-error"
              role="alert"
              :data-testid="`waitlist-${action}-error`"
            >
              {{ errorMessage }}
            </p>
            <UButton
              class="mt-6"
              color="neutral"
              :loading="state === 'working'"
              :data-testid="`waitlist-${action}-button`"
              @click="onAct"
            >
              {{ t(`${copyKey}.button`) }}
            </UButton>
          </template>
        </template>
      </section>
    </main>
  </div>
</template>
