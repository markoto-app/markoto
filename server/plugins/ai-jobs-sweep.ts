import { deleteOldAiJobs, markStaleAiJobsInterrupted, purgeAiJobBeforeTexts } from '../repos/aiJobs'
import { system } from '../repos/proofs'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { stopAllJobs } from '../utils/ai/jobs/engine'
import { SWEEPS } from '../config/sweeps'
import { DAY_MS, HOUR_MS } from '~~/shared/config/units'

// Delegated AI jobs (`server/utils/ai/jobs/`):
//   - a `running` job whose heartbeat is older than `staleAfterMs` lost its
//     instance (crash, deploy): it becomes `interrupted` and its running
//     units pending again, so "Resume" continues where it stopped;
//   - unit before-texts (document content kept for "Undo job") are purged
//     `idleAfterDays` after the job started;
//   - job rows are deleted after the AI records retention (90 days).
// On shutdown the jobs of this instance stop and become `interrupted`.

const { staleAfterMs, idleAfterDays } = SWEEPS.aiJobs
const JOB_RETENTION_DAYS = 90
let lastPurge = 0

export default defineSweeper({
  name: 'ai-jobs-sweep',
  schedule: SWEEPS.aiJobs,
  onClose: stopAllJobs,
  run: async () => {
    const by = system('ai-jobs-sweep')
    const now = Date.now()
    const interrupted = await markStaleAiJobsInterrupted(by, new Date(now - staleAfterMs))
    let purged = 0
    let deleted = 0
    if (now - lastPurge >= HOUR_MS) {
      lastPurge = now
      purged = await purgeAiJobBeforeTexts(by, new Date(now - idleAfterDays * DAY_MS))
      deleted = await deleteOldAiJobs(by, new Date(now - JOB_RETENTION_DAYS * DAY_MS))
    }
    return interrupted.length + purged + deleted > 0 ? { interrupted: interrupted.length, purged, deleted } : undefined
  }
})
