/**
 * Full-page navigation to another origin (Stripe Checkout / Portal).
 * One seam so component tests can assert the target without replacing
 * `window.location`.
 */
export function goToExternal(url: string): void {
  globalThis.location.href = url
}
