// Every admin page: signed-out visitors go to the login, signed-in
// non-admins to the home page. The endpoints check admin rights on their
// own; this only keeps the admin chrome from showing. `isAdmin` gates the
// page's data queries.
export function useAdminGate() {
  const router = useRouter()
  const { loggedIn } = useUserSession()
  // Login starts at the first configured provider ('/' when none).
  const { primaryLoginPath } = useInstanceConfig()
  const { status: accountStatus } = useAccountStatus()

  if (import.meta.client) {
    watchEffect(() => {
      if (!loggedIn.value) {
        globalThis.location.href = primaryLoginPath.value ?? '/'
      } else if (accountStatus.value && !accountStatus.value.isAdmin) {
        void router.push('/')
      }
    })
  }

  const isAdmin = computed(() => loggedIn.value && accountStatus.value?.isAdmin === true)
  return { isAdmin }
}
