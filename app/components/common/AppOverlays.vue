<script setup lang="ts">
// App-wide overlays layered above every page. The onboarding gate and
// consent banner exist only where the legal surfaces are on (hosted SaaS);
// a self-hosted instance is its own operator and ships without them by
// default — see shared/config/instance.ts.
const { legalSurfaces } = useInstanceConfig()
// The server-render page (/_internal/render/*) is loaded by the Playwright
// sidecar and captured as PDF/PNG — no overlay may paint over it.
const route = useRoute()
const showOverlays = computed(() => !route.path.startsWith('/_internal/'))
</script>

<template>
  <template v-if="showOverlays">
    <!-- Browser-level offline banner — shown above all routes so the
         user sees it everywhere (dashboard, editor, workspace, docs).
         Auto-hides when the network comes back. -->
    <CommonOfflineBanner />
    <!-- Visible across every authenticated route while a deletion is
         scheduled. Hidden silently for anonymous users / users with
         no pending deletion. -->
    <LegalAccountDeletionGraceBanner />
    <!-- Onboarding gate — blocks the app on first login until the
         user confirms age + accepts current Privacy Policy + ToS.
         Hidden for anonymous users (no row to attach acceptance
         to) and for users who already accepted the current versions. -->
    <LegalOnboardingGate v-if="legalSurfaces" />
    <!-- Cookie / consent banner — first-visit prompt + persistent
         re-open via the footer "Privacy choices" link. Renders for
         anonymous + logged-in alike (ePrivacy is identity-agnostic). -->
    <LegalConsentBanner v-if="legalSurfaces" />
  </template>
</template>
