// Polls /api/version every few minutes and on window focus. If the server's
// build id no longer matches the one we first saw, the SPA is stale relative
// to the deployed code — prompt the user to reload.
//
// We deliberately don't auto-reload: the user might be mid-edit. A sticky
// toast with a manual Reload button is the right balance.
//
// In dev (`buildId === 'dev'`) this is effectively a no-op: dev builds keep
// the same id forever, so a mismatch is impossible. The poll still runs but
// quietly.

const POLL_INTERVAL_MS = 5 * 60 * 1000

export default defineNuxtPlugin(() => {
  const toast = useToast()
  let baseline: string | null = null
  let stop = false
  let interval: ReturnType<typeof setInterval> | null = null

  async function check() {
    if (stop) return
    let buildId: string | null = null
    try {
      const res = await $fetch<{ buildId: string }>('/api/version')
      buildId = res?.buildId ?? null
    } catch {
      return
    }
    if (!buildId) return

    if (baseline === null) {
      baseline = buildId
      return
    }
    if (buildId === baseline) return

    // Mismatch — show the prompt once and stop polling so we don't pile up toasts.
    stop = true
    if (interval) clearInterval(interval)

    toast.add({
      title: 'New version available',
      description: 'Reload to get the latest update.',
      icon: 'i-lucide-refresh-cw',
      color: 'primary',
      duration: 0,
      actions: [{
        label: 'Reload',
        onClick: () => window.location.reload()
      }]
    })
  }

  // Initial baseline fetch, then polling + focus re-check.
  check()
  interval = setInterval(check, POLL_INTERVAL_MS)
  window.addEventListener('focus', check)
})
