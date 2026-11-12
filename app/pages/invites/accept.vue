<script setup lang="ts">
// Landing card for the link in a workspace-invitation email
// (`/invites/accept?token=…`). The token is only sent to the API on an
// explicit click, never on page load, so mail scanners that prefetch
// links can't accept or decline on someone's behalf.
//
// Accepting needs an account. A signed-out visitor sees the sign-in
// buttons; the token is parked in sessionStorage (PENDING_INVITE_KEY)
// so the dashboard can bring them back here after the OAuth round trip.
import { useAnswerInviteByToken } from '~/queries/workspaces'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { loggedIn } = useUserSession()
const { extractError } = useErrorHandler()

const token = computed(() => {
  const raw = route.query.token
  return typeof raw === 'string' && raw.length > 0 ? raw : null
})

const state = ref<'idle' | 'working' | 'declined' | 'error'>('idle')
const errorMessage = ref<string | null>(null)

onMounted(() => {
  if (!token.value) return
  if (loggedIn.value) clearPendingInviteToken()
  else storePendingInviteToken(token.value)
})

// Accepting refreshes the workspace list the next page shows.
const answerInvite = useAnswerInviteByToken()
async function onAct(action: 'accept' | 'decline'): Promise<void> {
  if (!token.value || state.value === 'working') return
  state.value = 'working'
  errorMessage.value = null
  try {
    const res = await answerInvite.mutateAsync({ token: token.value, action })
    clearPendingInviteToken()
    if (res.action === 'accept') {
      // A guest has no workspace page: their shared documents
      // are on the dashboard.
      await router.push(res.role === 'guest' ? '/' : `/w/${res.workspaceId}`)
      return
    }
    state.value = 'declined'
  } catch (e) {
    clearPendingInviteToken()
    errorMessage.value = extractError(e).message
    state.value = 'error'
  }
}

useHead({
  title: () => t('workspace.invites.page.title'),
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
        data-testid="invite-accept-card"
      >
        <h1 class="font-serif text-2xl font-normal tracking-tight">
          {{ t('workspace.invites.page.title') }}
        </h1>

        <template v-if="state === 'declined'">
          <p
            class="mt-2 text-sm text-muted"
            data-testid="invite-declined"
          >
            {{ t('workspace.invites.page.declined') }}
          </p>
          <UButton
            class="mt-6"
            color="neutral"
            variant="subtle"
            to="/"
          >
            {{ t('workspace.invites.page.home') }}
          </UButton>
        </template>

        <p
          v-else-if="!token"
          class="mt-2 text-sm text-muted"
          role="alert"
        >
          {{ t('workspace.invites.page.missingToken') }}
        </p>

        <template v-else>
          <p class="mt-2 text-sm text-muted">
            {{ t('workspace.invites.page.intro') }}
          </p>
          <ClientOnly>
            <template v-if="loggedIn">
              <p
                v-if="errorMessage"
                class="mt-3 text-sm text-error"
                role="alert"
                data-testid="invite-accept-error"
              >
                {{ errorMessage }}
              </p>
              <div class="mt-6 flex gap-2">
                <UButton
                  color="neutral"
                  :loading="state === 'working'"
                  data-testid="invite-accept-button"
                  @click="onAct('accept')"
                >
                  {{ t('workspace.invites.page.accept') }}
                </UButton>
                <UButton
                  color="neutral"
                  variant="ghost"
                  :disabled="state === 'working'"
                  data-testid="invite-decline-button"
                  @click="onAct('decline')"
                >
                  {{ t('workspace.invites.decline') }}
                </UButton>
              </div>
            </template>
            <template v-else>
              <p class="mt-4 mb-3 text-sm">
                {{ t('workspace.invites.page.signIn') }}
              </p>
              <AuthLoginButtons />
            </template>
          </ClientOnly>
        </template>
      </section>
    </main>
  </div>
</template>
