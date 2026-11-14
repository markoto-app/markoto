// Constants of the billing-sandbox tier: the real app server against
// Stripe's real test-mode API (docs/contributing/testing.md).

/** The variable that turns the tier on: a Stripe TEST-mode secret (or restricted) key. */
export const SANDBOX_KEY_ENV = 'STRIPE_SANDBOX_SECRET_KEY'

/**
 * The sandbox key, or null when the tier is off. A key that is not a
 * test-mode key is refused outright: this suite creates customers, charges
 * cards and advances clocks, which must never reach a live account.
 */
export function sandboxKey(): string | null {
  const key = process.env[SANDBOX_KEY_ENV]
  if (!key) return null
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error(`[billing-sandbox] ${SANDBOX_KEY_ENV} is not a Stripe test-mode key (it must start with sk_test_ or rk_test_). Refusing to run.`)
  }
  return key
}

/** Whether the tier runs; every suite is `describe.skipIf(!SANDBOX_CONFIGURED)`. */
export const SANDBOX_CONFIGURED = Boolean(process.env[SANDBOX_KEY_ENV])

// Its own port, so the server can run beside the integration tier's two
// (3101, 3102).
export const SANDBOX_PORT = 3103
export const SANDBOX_BASE_URL = `http://127.0.0.1:${SANDBOX_PORT}`

/**
 * Metadata key on every Stripe object the suite creates; the value is the
 * run id. The sandbox is shared with the staging server, so the suite only
 * ever deletes objects that carry it.
 */
export const RUN_TAG = 'markoto_test_run'

/** Name prefix of the suite's test clocks (a clock has no metadata). */
export const CLOCK_NAME_PREFIX = 'markoto-test-run'

/** Prefix of the workspace ids the suite creates: names the Stripe customers the app creates for them. */
export const WORKSPACE_ID_PREFIX = 'bsx'

const RUN_ID_ENV = 'BILLING_SANDBOX_RUN_ID'

/** Set once by globalSetup; the test workers inherit it. */
export function setRunId(id: string): void {
  process.env[RUN_ID_ENV] = id
}

export function runId(): string {
  const id = process.env[RUN_ID_ENV]
  if (!id) throw new Error('[billing-sandbox] no run id: globalSetup did not run')
  return id
}

/** Tagged objects older than this belong to a run that died; the next run removes them. */
export const STALE_RUN_SECONDS = 3 * 3600
