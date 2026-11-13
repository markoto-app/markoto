import { runWorkspaceInviteSweep } from '../utils/workspaces/workspaceInviteSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'

// Hourly sweeper that deletes expired workspace invitations. Logic lives
// in `server/utils/workspaces/workspaceInviteSweep.ts` so tests can drive it
// directly.

export default defineSweeper({
  name: 'workspace-invite-sweep',
  schedule: SWEEPS.workspaceInvites,
  run: runWorkspaceInviteSweep
})
