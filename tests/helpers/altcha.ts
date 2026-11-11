import type { Challenge } from 'altcha-lib'
import type { AltchaChallenge } from '../../app/utils/platform/altchaSolver'

// altcha-lib types `parameters` as an interface, which TypeScript will not accept where the browser-side solver
// asks for `Record<string, unknown>` (interfaces have no implicit index signature). Spreading yields a plain
// object type with identical runtime content.
export function toSolverChallenge(challenge: Challenge): AltchaChallenge {
  return { ...challenge, parameters: { ...challenge.parameters } }
}
