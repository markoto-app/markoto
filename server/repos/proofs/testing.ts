// Test-only minting. Tests call repo functions directly and need proofs for
// the objects they create; this module hands them the access layer's mint
// functions. ESLint refuses an import of this file outside `tests/**`, and
// depcruise refuses it from any production path.

export {
  mintAdminActor as __mintAdminActor,
  mintDocAccess as __mintDocAccess,
  mintDocLookup as __mintDocLookup,
  mintUserScope as __mintUserScope,
  mintWorkspaceAccess as __mintWorkspaceAccess,
  userActor as __userActor
} from './mint'
