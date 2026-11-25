// After a sign-in the server sends the browser back to the page it started
// on, marked `?signed_in=1` (plus `linked=<provider>` when a second
// provider was added to an existing account; server/utils/auth/loginReturn.ts).
//
// Here, before the app mounts (so a document page opened next already
// loads as its owner's): the anonymous documents this browser wrote become
// the account's (`POST /api/docs/adopt`, keyed on the creator-key cookie),
// then one toast says so, another one explains a linked account, and the
// markers leave the address bar so a reload doesn't repeat them.
//
// `signed_up` is read by the analytics plugin in the same hook; it is
// removed here too, after that plugin has read it.

import { adoptedToast, signInMarkers } from '~/utils/account/signInReturn'

export default defineNuxtPlugin({
  name: 'markoto:sign-in-return',
  async setup(nuxtApp) {
    const markers = signInMarkers(new URL(globalThis.location.href).searchParams)
    if (!markers) return

    let adopted = 0
    try {
      const res = await apiFetch('/api/docs/adopt', { method: 'post', retry: 0 })
      adopted = res.adopted
    } catch {
      // Best effort: the documents stay anonymous and the next sign-in
      // in this browser tries again.
    }

    nuxtApp.hooks.hookOnce('app:suspense:resolve', () => {
      void nuxtApp.runWithContext(async () => {
        const { t } = nuxtApp.$i18n
        const toast = useToast()
        const toAdd = adoptedToast(adopted)
        if (toAdd) {
          toast.add({
            title: t('auth.adoptedTitle', { n: toAdd }, toAdd),
            description: t('auth.adoptedDescription', { n: toAdd }, toAdd),
            icon: 'i-lucide-file-check',
            color: 'success'
          })
        }
        if (markers.linked) {
          const { config } = useInstanceConfig()
          const provider = markers.linked === 'github'
            ? 'GitHub'
            : markers.linked === 'google' ? 'Google' : (config.value.oidcProviderName || t('auth.oidcDefaultName'))
          toast.add({
            title: t('auth.linkedTitle'),
            description: t('auth.linkedDescription', { provider }),
            icon: 'i-lucide-link',
            color: 'success'
          })
        }
        // After the other `app:suspense:resolve` hooks (analytics reads
        // `signed_up` there), from the route as it is by then.
        await new Promise(resolve => setTimeout(resolve, 0))
        const router = useRouter()
        await router.isReady()
        const query = { ...router.currentRoute.value.query, signed_in: undefined, linked: undefined, signed_up: undefined }
        await router.replace({ query, hash: router.currentRoute.value.hash })
      })
    })
  }
})
