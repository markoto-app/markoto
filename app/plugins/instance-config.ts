// Same reasoning as `billing-mode.ts`: makes the server resolve
// `useInstanceConfig()` on every page so the login buttons, legal gate and
// footer see the real value after client-side navigation.

export default defineNuxtPlugin(() => {
  useInstanceConfig()
})
