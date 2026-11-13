# Logging

Backend code (`server/`, `sync-server/src/`, `renderer/src/`) logs through one small logger, never `console.*` (ESLint `no-console` is an error there; the only exceptions are the boot-time configuration report of each process and the nitropack entry copy, listed in `eslint.config.mjs`).

```ts
import { useLogger } from '~~/server/utils/platform/logger'   // sync-server: './logger', renderer: './logger'

const log = useLogger('stripe-webhook')                        // one stable name per module or domain

log.info('subscription updated', { subscriptionId, plan })
log.warn('LiteLLM key budget sync failed', { userId, err: e })
log.with({ sessionId }).debug('turn finished', { turn })       // bound fields on every record
```

The implementation is `shared/logging/core.ts`, with its redaction rules in `shared/logging/redaction.ts` (no package imports). The Sentry scrubber (`shared/utils/security/sentryScrub.ts`) uses the same redaction core with a stricter key policy, so a new secret shape added there covers logs and telemetry alike.

## Output

- **Production** (`NODE_ENV=production`): one JSON object per line on stdout (`debug` / `info`) or stderr (`warn` / `error`): `time` (ISO 8601), `level`, `component`, `msg`, then the structured fields.
- **Development**: one readable line per record: `12:01:02.345 WARN  [component] msg key=value`.
- **Vitest** (`NODE_ENV=test`): silent. A test that asserts on logs captures them: `const logs = captureLogs()` from `tests/helpers/logs.ts`, then `logs.find('warn', 'msg')` / `logs.all('error')`. Captured records are redacted and level-filtered like production ones.
- Minimum level: `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`), read per process.

## Levels

| Level | Use |
|---|---|
| `error` | A fault the operator should look at: an operation failed and was not recovered, data may be inconsistent. |
| `warn` | Degraded but handled: a best-effort step failed, a dependency is flaky, a request was refused for a reason that points at configuration or abuse. |
| `info` | What a healthy system reports about itself: boot, shutdown, one summary line per sweep run. Not per request. |
| `debug` | Per-request / per-turn chatter and expected client errors. Off in production. |

Expected outcomes (a 4xx the client caused, a lost lock race, a deduplicated insert) are `debug`, not `warn`.

## Messages and fields

- `msg` is a short constant: no ids, names or numbers interpolated. Put those in fields (`{ docId, userId }`), so lines group and filter.
- Field names are camelCase and consistent across modules: `docId`, `userId`, `workspaceId`, `sessionId`, `subscriptionId`, `eventId`, `status`, `durationMs`.
- An error goes in `err`: `log.error('processing failed', { err: e })` writes `{ name, message, stack, code?, status?, cause? }`. Pass the thrown value as is; do not pre-format `e.message`.

## What never to log

The logger enforces the basics (below), but the first line of defence is not passing the data in.

- Document titles, document or comment text, prompts, uploaded file contents or names.
- Email addresses, names, IP addresses. Log the user id.
- Tokens, keys, passwords, cookies, `Authorization` headers, request or response bodies.
- URLs with a query string (render tokens `?t=`, presigned S3 URLs), or raw error text from a provider that may echo a key or a prompt. Log the status code and your own error code.

Enforced by `shared/logging/core.ts` on every record:

- Fields whose name ends in or contains `token`, `password`, `secret`, `authorization`, `cookie`, `apiKey`, `privateKey`, `accessKey`, `credential`, `jwt` are replaced by `[redacted]` (`totalTokens` is fine: only a name that *ends* in `token` matches).
- `body`, `headers` and `payload` fields are replaced by `[omitted]`.
- Email addresses (an `…email` field, or inside any string) are masked to `a***@domain`: operators can still see which domain, not the person.
- In strings, URL query strings become `?[query]`, `user:pass@` becomes `[redacted]@`, `Bearer …`, JWTs and `sk-…` / `whsec_…` style keys become `[redacted]`.
- Strings are cut at 500 characters (messages 300, stacks 2000), arrays at 20 items, objects at 40 keys and 4 levels.
- A field named `time`, `level`, `component` or `msg` is stored as `field_<name>`, so a record cannot be spoofed from data.

Provider calls that carry a user's own key also go through `redactSecret` (`server/utils/aiProviders/requestFields.ts`) before the message is logged: the pattern rules above cannot know an arbitrary key.

## Request correlation

`server/middleware/00.request-context.ts` gives every request an id (a caller's `x-request-id` is kept when it is id-shaped, otherwise a UUID), sets it on the response as `x-request-id`, and keeps it in an `AsyncLocalStorage`, so every record logged while the request is handled carries `requestId`. `injectTraceHeaders` (`server/utils/platform/traceHeaders.ts`) forwards it on the calls to the sync server and the renderer, whose request-scoped records carry the same `requestId`. Sweepers, boot and the sync server's WebSocket traffic have no request and no id.
