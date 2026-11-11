/**
 * Where a managed private instance's users get help (WP16): the operator's
 * support page, else a mailto: link to the support address, else null.
 */
export function useInstanceSupport() {
  const { brand } = useInstanceConfig()
  const supportHref = computed<string | null>(() => {
    if (brand.value.supportUrl) return brand.value.supportUrl
    if (brand.value.supportEmail) return `mailto:${brand.value.supportEmail}`
    return null
  })
  return { supportHref }
}
