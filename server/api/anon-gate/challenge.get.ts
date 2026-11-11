import { issueAnonChallenge } from '../../utils/anonGate/gate'
import { anonChallengeQuery } from '~~/shared/api/legal'

// ALTCHA challenge for an anonymous visitor (self-hosted proof of work,
// see server/utils/anonGate/altcha.ts). `?purpose=doc-create|abuse-report`
// is signed into the challenge. Also reports whether this browser has
// already accepted the current terms (so the UI can skip the checkbox).
//
// Never cached, IP-limited: creating a challenge costs the server one PBKDF2 derivation.

export default defineApiHandler({
  access: allow.public('Anonymous visitors fetch their bot-check challenge before creating a document or filing a report; limited per client'),
  query: anonChallengeQuery,
  rateLimit: { namespace: 'anon-gate-challenge', max: 60, windowMs: 60_000, key: 'ip', error: 'anon-gate/rate-limited' },
  handler: ({ event, query }) => {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return issueAnonChallenge(event, query.purpose)
  }
})
