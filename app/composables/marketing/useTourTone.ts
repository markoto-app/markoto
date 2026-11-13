/**
 * The product page's colour phase, shared by `LandingProductTour`
 * (which sets it from the scroll position) and the page header in
 * `pages/index.vue` (whose toggle shows and flips what is on screen).
 *
 * - `mode`: `auto` = the light → dark flip; `light` / `dark` = the visitor
 *   picked one with the page's toggle during THIS visit. A colour mode
 *   stored from an earlier visit (or from the editor) never switches the
 *   flip off: Nuxt's toggle only ever stores light/dark, so a single old
 *   click would otherwise disable it for good.
 * - `dark`: in `auto`, whether the page is past the flip scene.
 */
export function useTourTone() {
  const mode = useState<'auto' | 'light' | 'dark'>('mk-tour-tone-mode', () => 'auto')
  const dark = useState<boolean>('mk-tour-tone-dark', () => false)
  const shownDark = computed(() => (mode.value === 'auto' ? dark.value : mode.value === 'dark'))
  return { mode, dark, shownDark }
}
