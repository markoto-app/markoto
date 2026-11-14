// Default idle timeout of the production server (bunEntry.ts). Bun closes
// a connection that sends nothing for this many seconds, and a request
// whose handler is still working sends nothing, so the value must stay
// above the slowest route's own deadline: then that route answers with
// its own error (504) instead of the connection ending without a reply.
// Pinned against those deadlines by tests/unit/platform/idleTimeout.test.ts.

/** Seconds. Override: NITRO_BUN_IDLE_TIMEOUT (Bun accepts at most 255). */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 120
