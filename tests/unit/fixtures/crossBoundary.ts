import { CrossBoundaryGuard, type CrossBoundaryDeps } from '../../../server/utils/agentic/crossBoundary'

function defaultDeps(deps: Partial<CrossBoundaryDeps>): CrossBoundaryDeps {
  return {
    isDocSolo: async () => true,
    describeDoc: async () => null,
    commentsHaveForeignAuthors: () => false,
    workspaceHasOtherEditors: async () => false,
    confirm: async () => false,
    ...deps
  }
}

/**
 * Taint gate for loop tests that are about something else: a solo
 * session (nothing foreign read yet), every doc counts as the invoker's
 * own, no foreign comments. `confirm` resolves false, so a test that
 * DOES reach a confirmation sees a denial rather than silently passing.
 */
export function soloSessionGuard(deps: Partial<CrossBoundaryDeps> = {}): CrossBoundaryGuard {
  return new CrossBoundaryGuard({ initialTaint: null, invokerText: [], knowledgeFiles: new Map() }, defaultDeps(deps))
}

/** A session that starts tainted (the document has other editors). */
export function taintedSessionGuard(deps: Partial<CrossBoundaryDeps> = {}): CrossBoundaryGuard {
  return new CrossBoundaryGuard({ initialTaint: 'the shared document', invokerText: [], knowledgeFiles: new Map() }, defaultDeps(deps))
}
