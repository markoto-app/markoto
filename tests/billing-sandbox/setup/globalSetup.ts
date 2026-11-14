import type { ChildProcess } from 'node:child_process'
import { closeTestDb, waitForDb } from '../../integration/setup/db'
import { ensureTestBuild, primaryServerEnv, spawnServer, stopProcess, waitForHealth } from '../../integration/setup/server'
import { SANDBOX_BASE_URL, SANDBOX_KEY_ENV, SANDBOX_PORT, sandboxKey, setRunId } from './env'
import { listRunObjects, removeRunObjects, removeStaleRunObjects, sandboxStripe } from './stripe'

// vitest globalSetup of the billing-sandbox tier. Without a sandbox key it
// does nothing (the suites report themselves skipped). With one it boots
// ONE app server from the integration tier's build, pointed at Stripe's
// real test-mode API instead of stripe-mock, and removes every Stripe
// object of the run at the end.

export default async function globalSetup() {
  const key = sandboxKey()
  if (!key) {
    console.log(`[billing-sandbox] ${SANDBOX_KEY_ENV} is not set: the tier is SKIPPED (not run, not passed).`)
    return
  }
  const startedAt = Date.now()
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  setRunId(id)
  console.log(`[billing-sandbox] run ${id}`)

  await waitForDb()
  ensureTestBuild()

  const env = primaryServerEnv({ secretKey: key, apiBase: '', priceIds: '' })
  env.NITRO_PORT = String(SANDBOX_PORT)
  env.PORT = String(SANDBOX_PORT)
  env.TEST_BASE_URL = SANDBOX_BASE_URL
  // The real litellm-test proxy: the suites assert the key and team budgets.
  env.LITELLM_TEST_STUB = ''
  // No identity provider in this tier's stack.
  for (const name of Object.keys(env)) {
    if (name.startsWith('NUXT_OAUTH_OIDC_')) Reflect.deleteProperty(env, name)
  }

  let server: ChildProcess | null = null
  const stripe = sandboxStripe()
  try {
    await removeStaleRunObjects(stripe)
    console.log(`[billing-sandbox] starting the app on :${SANDBOX_PORT} against the Stripe test-mode API`)
    server = spawnServer(env, 'nuxt-billing-sandbox')
    await waitForHealth(SANDBOX_BASE_URL, server)
  } catch (e) {
    if (server) await stopProcess(server)
    throw e
  }

  return async () => {
    if (server) await stopProcess(server)
    // Each file deletes its own clocks and customers; this catches what a
    // failed file left, and the run fails if the sandbox is not clean after.
    const removed = await removeRunObjects(stripe, id)
    const left = await listRunObjects(stripe, id)
    await closeTestDb()
    console.log(`[billing-sandbox] run ${id}: ${removed.clocks} test clock(s) and ${removed.customers} customer(s) removed at teardown, ${left.length} left in the sandbox; wall time ${Math.round((Date.now() - startedAt) / 1000)} s`)
    if (left.length > 0) throw new Error(`[billing-sandbox] run ${id} left objects in the Stripe sandbox: ${left.join(', ')}`)
  }
}
