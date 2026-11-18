<script setup lang="ts">
import { DEFAULT_TITLE } from '~~/shared/seo/meta'

// `/f/:folderId` opens a folder of the signed-in user's personal documents
// in the dashboard's explorer (links, back / forward). One page and one key
// for both addresses: opening a folder keeps the dashboard mounted. A page
// of its own remounted the whole dashboard on every folder change, and an
// action that opens a folder first ("New folder" inside another folder)
// finished on the unmounted copy: the rename never started.
definePageMeta({ alias: '/f/:folderId', key: 'home' })

const { t } = useI18n()
const router = useRouter()
const { loggedIn } = useUserSession()

const toast = useToast()

// Hosted markoto.app shows the scroll-driven product page to logged-out
// visitors (NUXT_MARKETING_SITE_ENABLED); everyone else gets the
// plain hero + dashboard (components/home/Dashboard.vue).
const { marketingSite } = useInstanceConfig()
const showTour = computed(() => marketingSite.value && !loggedIn.value)
// The product page paints from the server render; its code follows
// without modulepreload hints (useLeanResourceHints). Not the dashboard.
useLeanResourceHints(() => showTour.value)

// Home: the brand-led default title, untemplated. The hero sentence
// (`landing.subtitle`, also the tour's hero copy) is the description.
useMarketingSeo({
  title: DEFAULT_TITLE,
  description: () => t('landing.subtitle'),
  bareTitle: true
})
// JSON-LD (Organization + WebSite + SoftwareApplication), hosted only.
useHomeStructuredData()
// The tour's colours (useTourTone): it starts light and turns dark while
// scrolling (ProductTour.vue). Only a choice made with this page's toggle
// during this visit switches the flip off, a colour mode stored earlier
// doesn't (Nuxt's toggle only ever stores light/dark, so one old click
// would disable the flip for good). The toggle shows and flips what is on
// screen, and stores the choice for the rest of the app too.
const colorMode = useColorMode()
const { mode: tourTone, dark: tourDark, shownDark: tourShownDark } = useTourTone()
function toggleTourTone(): void {
  const next = tourShownDark.value ? 'light' : 'dark'
  tourTone.value = next
  colorMode.preference = next
}
const { providerName } = useLoginOptions()

// OAuth account-merge flash. The auth handler redirects to
// `/?linked=github`, `/?linked=google` or `/?linked=oidc` when a second-provider
// sign-in landed on an existing row (matched by verified email) and
// we added the new provider id to it. Surface a one-time toast
// explaining what happened, then strip the query param so a reload
// doesn't re-show the toast.
onMounted(() => {
  const route = useRoute()
  const linked = route.query.linked
  if (typeof linked === 'string' && (linked === 'github' || linked === 'google' || linked === 'oidc')) {
    toast.add({
      title: t('auth.linkedTitle'),
      description: t('auth.linkedDescription', { provider: providerName(linked) }),
      icon: 'i-lucide-link',
      color: 'success'
    })
    // Strip the query param so a reload doesn't re-fire the toast.
    void router.replace({ query: { ...route.query, linked: undefined } })
  }
})

// New-doc dialog: seeds title/description/audience/language/theme up
// front, so the AI has authoritative context from the first prompt.
// "Just give me a blank doc" inside the dialog skips the setup. Mounted on first use
// (useNewDocDialog), so the product page doesn't ship it.
const { mounted: newDocDialogMounted, open: showNewDocDialog, show: createDocument, warm: warmNewDocDialog } = useNewDocDialog(() => import('~/components/document/NewDocumentDialog.vue'))
function onDocCreated(docId: string) {
  void router.push(`/d/${docId}`)
}
const pageRoute = useRoute()
const personalFolderId = computed(() => typeof pageRoute.params.folderId === 'string' && pageRoute.params.folderId ? pageRoute.params.folderId : null)
// "New document" in a personal folder files the document there.
const newDocFolder = ref<string | null>(null)
function createDocumentIn(folderId?: string | null) {
  newDocFolder.value = folderId ?? null
  createDocument()
}
</script>

<template>
  <div
    class="min-h-screen flex flex-col"
    :class="showTour ? ['mk-tour-page', `mk-tour-page--${tourTone}`, { 'is-dark': tourTone === 'auto' && tourDark }] : []"
  >
    <!-- Header (MarketingHeader): wordmark + seal lockup, Pricing /
         use cases / Self-host / Docs, login. The tour swaps in its
         page-local colour toggle. -->
    <MarketingHeader>
      <template #mode>
        <UButton
          v-if="showTour"
          color="neutral"
          variant="ghost"
          class="mk-tone-toggle"
          :icon="tourShownDark ? 'i-lucide-sun' : 'i-lucide-moon'"
          :aria-label="tourShownDark ? t('tour.tone.toLight') : t('tour.tone.toDark')"
          data-testid="tour-tone-toggle"
          @click="toggleTourTone"
        />
        <UColorModeButton v-else />
      </template>
    </MarketingHeader>

    <!-- Hero. Editorial register from the homepage mockup,
         Fraunces weight 300 display, italic-400 emphasis on the
         brand's loadbearing word ("Markdown"), Inter lede capped at
         34ch. -->
    <LandingProductTour
      v-if="showTour"
      class="flex-1"
      @start="createDocument"
      @warm="warmNewDocDialog"
    />
    <!-- Plain hero + dashboard (components/home/Dashboard.vue). Lazy: its
         chunk is preloaded only when the server rendered it, so the
         product page never ships the dashboard's code. -->
    <LazyHomeDashboard
      v-else
      :folder-id="personalFolderId"
      @new-document="createDocumentIn"
      @warm-new-document="warmNewDocDialog"
    />

    <!-- New-document dialog. Standalone (no workspace) on the home
         page; the workspace page passes its own workspaceId in. Outside
         <main> so the product tour's "Start writing" opens it too. -->
    <LazyDocumentNewDocumentDialog
      v-if="newDocDialogMounted"
      v-model:open="showNewDocDialog"
      :workspace-id="null"
      :folder-id="newDocFolder"
      @created="onDocCreated"
    />

    <!-- Hydrates when scrolled to (server-rendered links until then). -->
    <LazyCommonLegalFooter hydrate-on-visible />
  </div>
</template>
