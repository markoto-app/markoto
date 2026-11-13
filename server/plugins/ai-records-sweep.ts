import { runAiRecordsSweep } from '../utils/ai/aiRecordsSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Enforces the 90-day retention the privacy policy promises for AI prompt +
// tool-call records (`ai_session_messages`), plus reaps orphaned
// `ai_sessions` rows past the same window. See `utils/aiRecordsSweep.ts`.
// Daily is plenty: a bulk DELETE WHERE created_at < cutoff on an index.

export default defineSweeper({
  name: 'ai-records-sweep',
  schedule: SWEEPS.aiRecords,
  run: async () => {
    const result = await runAiRecordsSweep()
    return result.messagesDeleted > 0 || result.sessionsDeleted > 0 ? result : undefined
  }
})
