// Phase 7 split: this barrel keeps the historic import path
// (`server/utils/litellmKeys`) working while the implementation moves
// into single-purpose files under `litellm/`:
//
//   - `litellm/tokenCrypto.ts` — AES-256-GCM at-rest encryption for
//     bearer tokens. Pure crypto; auditable independently.
//   - `litellm/litellmAdmin.ts` — master-key authenticated HTTP wrapper
//     for the proxy's `/key/*` admin surface.
//   - `litellm/userKeys.ts` — per-user CRUD orchestration (lazy create,
//     budget update, spend reset, info read), plus the
//     `LitellmBudgetExhausted` error class + `isBudgetExceededError`
//     predicate.
//
// Callers can either keep importing from `~~/server/utils/litellmKeys`
// (this barrel) or import directly from the specific file. New code
// should prefer the specific paths so the dependency surface is
// explicit; this barrel exists for the existing call sites.

export * from './litellm/userKeys'
