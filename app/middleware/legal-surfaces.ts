// Route guard for the /legal/* pages. With legal surfaces off (the self-host
// default) the bundled texts, written for the hosted markoto.app service,
// don't exist on this instance; the matching API endpoints answer 404 too.
// See shared/config/instance.ts.
export default defineNuxtRouteMiddleware(() => {
  const { legalSurfaces } = useInstanceConfig()
  if (legalSurfaces.value) return
  return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
})
