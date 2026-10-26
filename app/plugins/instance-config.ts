// Hydrate the instance-config state on every SSR pass (same reasoning as
// `billing-mode.ts`): `useInstanceConfig()` resolves from the server
// environment the first time it's called on the server, so calling it here
// guarantees the login buttons, legal gate and footer see the real value
// after client-side navigation.

export default defineNuxtPlugin(() => {
  useInstanceConfig()
})
