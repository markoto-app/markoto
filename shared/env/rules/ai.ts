import type { Rule } from '../define'
import type { AppEnv } from '../namespaces'

const CAPABILITIES = [
  { prefix: 'NUXT_AI_DEFAULT_CHAT', what: 'chat', pick: (e: AppEnv) => [e.ai.chatModel, e.ai.chatBaseUrl, e.ai.chatApiKey] },
  { prefix: 'NUXT_AI_DEFAULT_IMAGE', what: 'image', pick: (e: AppEnv) => [e.ai.imageModel, e.ai.imageBaseUrl, e.ai.imageApiKey] },
  { prefix: 'NUXT_AI_DEFAULT_TRANSCRIBE', what: 'transcription', pick: (e: AppEnv) => [e.ai.transcribeModel, e.ai.transcribeBaseUrl, e.ai.transcribeApiKey] },
  { prefix: 'NUXT_AI_DEFAULT_WORKER', what: 'worker', pick: (e: AppEnv) => [e.ai.workerModel, e.ai.workerBaseUrl, e.ai.workerApiKey] }
] as const

export const aiRules: Rule<AppEnv>[] = [
  {
    services: ['app'],
    warning: true,
    vars: CAPABILITIES.flatMap(c => [`${c.prefix}_MODEL`, `${c.prefix}_BASE_URL`, `${c.prefix}_API_KEY`]),
    doc: 'A half-configured AI instance default is ignored (warning at boot).',
    check: (env) => {
      const problems: string[] = []
      for (const { prefix, what, pick } of CAPABILITIES) {
        const [model, baseUrl, apiKey] = pick(env)
        if (!model && (baseUrl || apiKey)) {
          problems.push(`${prefix}_BASE_URL/_API_KEY set without ${prefix}_MODEL, so the ${what} default is ignored.`)
        } else if (model && baseUrl && !apiKey) {
          problems.push(`${prefix}_BASE_URL set without ${prefix}_API_KEY, so the ${what} default is ignored (use any placeholder key for servers that need none).`)
        }
      }
      return problems
    }
  }
]
