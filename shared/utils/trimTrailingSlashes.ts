// Strip every trailing `/` from a URL-ish string. Used to normalise
// configured base URLs (`NUXT_LITELLM_URL`, sidecar health URLs, …)
// before concatenating a path.
//
// Deliberately a character-scan rather than `.replace(/\/+$/, '')`,
// that regex's unanchored-start + quantifier + `$` combination
// backtracks super-linearly (O(n²)) on a long run of slashes, which
// SonarQube flags (S8786). The loop is exactly linear and has the same
// result for every input.
export function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 0x2F /* '/' */) end--
  return end === value.length ? value : value.slice(0, end)
}
