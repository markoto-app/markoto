// Classifies the failure signals a flow collects (tests/e2e/fixtures/flow.ts):
// error toasts and 5xx answers from the app. Pure (no Playwright), so the
// rules are unit-tested (tests/unit/flowFailureSignals.test.ts).
//
// A flow that calls a live third-party provider can declare the provider's
// outage signal with `flow.allowProviderOutage(...)`: a 5xx from one route
// carrying one registered error code (e.g. 502 `ai/image-provider-unavailable`
// on POST /api/docs/:id/images/generate). When the ONLY failure signals are
// such outages, the flow ends SKIPPED (`skipForProviderOutage`) instead of
// failing. Any other signal (another route, another code, no code, a 500, an
// error toast the outage does not explain) still fails it.

export type ErrorToastSignal = { actor: string, title: string, description: string }

export type ServerErrorSignal = {
  actor: string
  status: number
  method: string
  path: string
  /** `data.code` of the JSON error body; null when there is none. */
  code: string | null
}

export type ProviderOutage = {
  /** Route that calls the provider, matched against the request path. */
  path: RegExp
  /** Registered error codes that mean "the provider is down". */
  codes: readonly string[]
  /** Error toasts the UI shows for this outage (tolerated only alongside it). */
  toasts?: readonly RegExp[]
  /** Why the flow is skipped, e.g. "the image provider (Black Forest Labs) is unavailable". */
  reason: string
}

export type FailureExpectations = {
  /** `flow.expectErrorToast`: toasts the flow provokes on purpose. */
  toasts: readonly RegExp[]
  /** `flow.expectServerError`: 5xx paths the flow provokes on purpose. */
  serverErrors: readonly RegExp[]
  /** `flow.allowProviderOutage`: live-provider outages that skip the flow. */
  outages: readonly ProviderOutage[]
}

export type FailureVerdict = {
  /** Signals that fail the flow; empty when none. */
  failures: string[]
  /** Set when the flow saw a declared provider outage (and nothing else failed it). */
  outage: ProviderOutage | null
}

/** 5xx statuses an upstream outage is answered with; a plain 500 is our own bug. */
const OUTAGE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

function matchingOutage(e: ServerErrorSignal, outages: readonly ProviderOutage[]): ProviderOutage | null {
  if (!OUTAGE_STATUSES.has(e.status) || e.code === null) return null
  const code = e.code
  return outages.find(o => o.path.test(e.path) && o.codes.includes(code)) ?? null
}

export function classifyFailureSignals(
  signals: { errorToasts: readonly ErrorToastSignal[], serverErrors: readonly ServerErrorSignal[] },
  expect: FailureExpectations
): FailureVerdict {
  const failures: string[] = []
  let outage: ProviderOutage | null = null
  for (const e of signals.serverErrors) {
    if (expect.serverErrors.some(re => re.test(e.path))) continue
    const hit = matchingOutage(e, expect.outages)
    if (hit) {
      outage ??= hit
      continue
    }
    failures.push(`server error [${e.actor}]: ${e.status} on ${e.method} ${e.path}${e.code ? ` (${e.code})` : ''}`)
  }
  const outageToasts = outage?.toasts ?? []
  for (const t of signals.errorToasts) {
    const matches = (re: RegExp) => re.test(t.title) || re.test(t.description)
    if (expect.toasts.some(matches) || outageToasts.some(matches)) continue
    failures.push(`error toast [${t.actor}]: "${t.title}"${t.description ? `, ${t.description}` : ''}`)
  }
  return { failures, outage: failures.length ? null : outage }
}

/** `data.code` of an app error body (`{ data: { code } }`, or `{ code }`); null otherwise. */
export function errorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const rec = body as { code?: unknown, data?: { code?: unknown } | null }
  const code = rec.data && typeof rec.data === 'object' ? rec.data.code : rec.code
  return typeof code === 'string' ? code : null
}
