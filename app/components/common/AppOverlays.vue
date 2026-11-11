<script setup lang="ts">
// App-wide overlays layered above every page. The onboarding gate exists
// only where the legal surfaces are on (hosted SaaS);
// a self-hosted instance is its own operator and ships without them by
// default — see shared/config/instance.ts.
//
// Every overlay that only a signed-in user can see, and the anonymous
// terms dialog, is a Lazy component mounted only when it can show: an
// anonymous visitor on a public page doesn't download them.
const { legalSurfaces, anonGate } = useInstanceConfig()
const { loggedIn } = useUserSession()
// The anonymous terms dialog mounts the first time something asks for it
// (useAnonTermsPrompt().ask()) and then stays, so closing animates.
const { state: anonTermsPrompt } = useAnonTermsPrompt()
const anonGateMounted = ref(false)
watch(() => anonTermsPrompt.value.open, (open) => {
  if (open) anonGateMounted.value = true
}, { immediate: true })
// The server-render page (/_internal/render/*) is loaded by the Playwright
// sidecar and captured as PDF/PNG — no overlay may paint over it.
const route = useRoute()
const showOverlays = computed(() => !route.path.startsWith('/_internal/'))
</script>

<template>
  <template v-if="showOverlays">
    <!-- Shown above all routes; hides when the network returns. -->
    <CommonOfflineBanner />
    <!-- Signed-in users only (no account, no deletion). -->
    <LazyLegalAccountDeletionGraceBanner v-if="loggedIn" />
    <!-- Blocks the app until the user confirms age + accepts the current
         Privacy Policy + ToS. Signed-in users only (no row to attach
         acceptance to). -->
    <LazyLegalOnboardingGate v-if="legalSurfaces && loggedIn" />
    <!-- No cookie banner: markoto stores only what the service needs
         (session, language, anonymous-document creator key), which
         ePrivacy Art.5(3) exempts from consent. The footer carries a
         short cookie note; privacy policy §9 lists every cookie. -->
    <!-- Accept-terms step before an anonymous visitor's first document
         (opened by useAnonDocCreate; shared/config/anonGate.ts). -->
    <LazyDocumentAnonGateDialog v-if="anonGate && anonGateMounted" />
  </template>
</template>
