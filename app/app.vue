<script setup lang="ts">
const { t } = useI18n()
// Onboarding gate + consent banner exist only where the legal surfaces
// are on (hosted SaaS). A self-hosted instance is its own operator and
// ships without them by default — see shared/config/instance.ts.
const { legalSurfaces } = useInstanceConfig()

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    // Brand fonts, calibrated against the homepage mockup. Inter is
    // the body/UI workhorse. JetBrains Mono is the eyebrow/meta/CTA
    // register. Fraunces (variable opsz, weights 300–500 upright +
    // 300–500 italic) handles the wordmark, display headlines, and
    // the AI's italic voice. Preconnect avoids a serial DNS hop.
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
    {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400&family=Fraunces:ital,opsz,wght@0,9..144,300..500;1,9..144,300..500&display=swap'
    }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

useSeoMeta({
  title: 'markoto — Collaborative Markdown',
  description: t('landing.subtitle'),
  ogTitle: 'markoto — Collaborative Markdown',
  ogDescription: t('landing.subtitle')
})
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }">
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
    <!-- NuxtLayout wraps NuxtPage with whatever layout the page opts
         into via definePageMeta({ layout: 'name' }). Pages without
         a layout meta render bare (no default layout file exists),
         so existing routes (/d/, /w/, /pricing, /) are unaffected.
         The /docs/* tree opts into the `docs` layout. -->
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
