// Per-model request fields for chat calls (agentic loop, delegated-job
// workers, sub-calls). Some models refuse the plain `temperature`-only
// request the app sends everywhere else, so every chat call spreads
// `modelRequestParams(fields.model, {...})` instead of writing
// `temperature` itself. Pure (no imports), so tests and eval harnesses can
// use it.
//
// Matched on the bare model id: a `byok/` prefix (the user's own key) and a
// provider prefix (`mistral/`) are ignored, so a user who brings a Mistral
// key for Large 4 gets a valid request too. Unknown ids (most BYOK models,
// operator endpoints, the `markoto-*` aliases) get only the temperature,
// exactly as before this map existed.
//
// Reasoning switches for the hosted deployments live in
// deploy/config/litellm/config.yaml, per deployment, so a LiteLLM fallback
// never receives a value the fallback model refuses:
//   - zai-glm-5-3-flash / markoto-worker / markoto-utility: `reasoning_effort:
//     low` (Mistral accepts low / high / max for GLM, `none` is a 400);
//   - deepseek-v4-1-flash-1017: `reasoning_effort: none` (0 reasoning tokens;
//     sending `none` from here would 400 on a GLM fallback);
//   - mistral-large-4 / markoto-worker-strong: `reasoning_effort: low` +
//     `top_p: 1`.
// The entries below only cover what the app must send itself.

export type ModelCallPurpose = 'loop' | 'worker' | 'subcall'

export interface ModelParamsInput {
  temperature: number
  /** Which kind of call asks; reserved for per-purpose tuning, no profile differs by it yet. */
  purpose: ModelCallPurpose
}

export interface ModelRequestParams {
  temperature: number
  top_p?: number
  reasoning_effort?: 'low'
}

interface ModelProfile {
  /** Matches the bare model id. */
  match: RegExp
  params: (input: ModelParamsInput) => Omit<ModelRequestParams, 'temperature'>
}

const PROFILES: readonly ModelProfile[] = [
  // Mistral Large 4 always reasons. `temperature: 0` without `top_p: 1` is a
  // 400 ("top_p must be 1 when using greedy sampling"), and `reasoning_effort`
  // takes low / medium / high, not `none` (model eval 2026-11, Mistral docs
  // "Reasoning"). `top_p: 1` is the API default, so it is sent at any
  // temperature. Large 3 (`mistral-large-2512`) does not reason and is not
  // matched.
  { match: /^mistral-large-(?:4|latest)(?:$|-)/, params: () => ({ top_p: 1, reasoning_effort: 'low' }) }
]

function bareModelId(model: string): string {
  const id = model.startsWith('byok/') ? model.slice('byok/'.length) : model
  const slash = id.lastIndexOf('/')
  return (slash === -1 ? id : id.slice(slash + 1)).toLowerCase()
}

/** The sampling / reasoning fields of one chat call to `model` (a LiteLLM alias or `byok/<id>`). */
export function modelRequestParams(model: string, input: ModelParamsInput): ModelRequestParams {
  const id = bareModelId(model)
  const profile = PROFILES.find(p => p.match.test(id))
  return { temperature: input.temperature, ...(profile ? profile.params(input) : {}) }
}
