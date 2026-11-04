import type { TourManifest } from '~~/shared/tour/manifest'

/**
 * The product tour's manifest (public/tour/manifest.json), validated on
 * the server (`shared/tour/data.ts`, zod) and handed to the client in the
 * SSR payload (~2 KB gzip). The import sits inside the handler, so the
 * page's browser bundle carries neither the JSON module nor zod (~23 KB
 * gzip); a client-side navigation loads them on demand.
 */
export async function useTourManifest(): Promise<TourManifest> {
  const { data } = await useAsyncData('tour-manifest', () => import('~~/shared/tour/data').then(m => m.tourManifest))
  if (!data.value) throw createError({ statusCode: 500, statusMessage: 'Tour manifest unavailable' })
  return data.value
}
