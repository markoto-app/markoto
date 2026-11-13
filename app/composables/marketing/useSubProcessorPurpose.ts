// What a sub-processor does, in the reader's language
// (`legal.subProcessors.purpose.<id>`). The registry's English sentence
// (server/legal/subProcessors.ts, delivered with the list) is the fallback
// for a sub-processor whose translation is missing.
export function useSubProcessorPurpose() {
  const { t, te } = useI18n()
  function subProcessorPurpose(sp: { id: string, purpose: string }): string {
    const key = `legal.subProcessors.purpose.${sp.id}`
    return te(key) ? t(key) : sp.purpose
  }
  return { subProcessorPurpose }
}
