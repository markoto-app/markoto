// Hydrate the billing-mode state on every SSR pass. `useBillingMode()`
// resolves the mode from the server environment the first time it's
// called on the server; calling it here guarantees that happens for
// every page (not only pages that happen to read the flag during
// render), so client-side navigations to /pricing etc. see the real
// value instead of the client-side "billing off" default.

export default defineNuxtPlugin(() => {
  useBillingMode()
})
