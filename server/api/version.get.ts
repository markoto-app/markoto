// Exposes the SPA build id so the client can detect a newer deployed build and
// prompt a reload. `useRuntimeConfig().app.buildId` is a hash in production and
// the literal "dev" in development.
export default defineApiHandler({
  access: allow.public('The build id is public; anonymous sessions poll it for version-skew detection'),
  handler: () => {
    const config = useRuntimeConfig()
    return { buildId: config.app.buildId }
  }
})
