/**
 * How far above the bottom edge the floating AI prompt bar sits. Virtual
 * keyboard awareness: without it the bar gets shoved off-screen on mobile
 * when the keyboard pops up, so the `visualViewport` API is watched for
 * keyboard intrusion and the bar sits just above it. On mobile (<sm) the
 * bottom MobileTabBar (~56px: 24px icon + 12px label + ~12px vertical
 * padding + safe-area-inset-bottom) sits at the very bottom of the
 * viewport, so its height is added; desktop keeps the standard 24px gap.
 */
export function usePromptBarOffset() {
  const keyboardOffset = ref(0)

  function updateKeyboardOffset() {
    const vv = globalThis.window?.visualViewport
    if (!vv) return
    const gap = window.innerHeight - vv.height - vv.offsetTop
    keyboardOffset.value = gap > 80 ? gap : 0
  }

  const isMobile = useMediaQuery('(max-width: 639px)')
  const FORMAT_BAR_HEIGHT_PX = 56

  const bottomOffset = computed(() => {
    const formatBarOffset = isMobile.value ? FORMAT_BAR_HEIGHT_PX : 0
    if (keyboardOffset.value > 0) {
      // Keyboard is up → sit just above the keyboard. The MobileFormatBar
      // is also re-anchored above the keyboard (via the same offset), so
      // we still need to clear it.
      return `${keyboardOffset.value + formatBarOffset + 8}px`
    }
    // Keyboard down → sit above the format bar (mobile) or the
    // standard 24px gap (desktop).
    return formatBarOffset > 0 ? `${formatBarOffset + 8}px` : '24px'
  })

  onMounted(() => {
    const vv = globalThis.window?.visualViewport
    if (!vv) return
    vv.addEventListener('resize', updateKeyboardOffset)
    vv.addEventListener('scroll', updateKeyboardOffset)
    updateKeyboardOffset()
  })

  onUnmounted(() => {
    const vv = globalThis.window?.visualViewport
    if (!vv) return
    vv.removeEventListener('resize', updateKeyboardOffset)
    vv.removeEventListener('scroll', updateKeyboardOffset)
  })

  return { bottomOffset }
}
