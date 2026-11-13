// `useBillingMode()` resolves the mode from the server environment on its
// first server-side call; calling it here makes that happen on every page,
// so client-side navigations to /pricing see the real value instead of the
// client default "billing off".

export default defineNuxtPlugin(() => {
  useBillingMode()
})
