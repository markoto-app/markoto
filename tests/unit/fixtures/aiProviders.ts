import type { ResolvedAiProviders } from '../../../server/utils/aiProviders/resolve'

/**
 * Every capability available via platform model aliases, the shape a
 * self-hosted instance with today's Mistral/BFL/Voxtral defaults
 * resolves to. Loop tests use it so no tool is filtered out by
 * `filterToolsForProviders`.
 */
export const FULL_AI_PROVIDERS: ResolvedAiProviders = {
  chat: { capability: 'chat', source: 'instance', model: 'mistral-small-2603', credentials: null, supportsVision: true },
  image: { capability: 'image', source: 'instance', model: 'flux-3-image-klein', credentials: null, supportsVision: false },
  transcription: { capability: 'transcription', source: 'instance', model: 'voxtral-mini-transcribe', credentials: null, supportsVision: false },
  worker: {
    fast: { capability: 'chat', source: 'instance', model: 'markoto-worker', credentials: null, supportsVision: false },
    strong: { capability: 'chat', source: 'instance', model: 'markoto-worker-strong', credentials: null, supportsVision: false }
  }
}
