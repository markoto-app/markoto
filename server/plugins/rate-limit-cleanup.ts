import { startRateLimitCleanup } from '../utils/rateLimit'

// Kicks off the hourly cleanup job for the rate_limits table so old rows
// don't accumulate forever. Idempotent — safe to re-run across HMR restarts.
export default defineNitroPlugin(() => {
  startRateLimitCleanup()
})
