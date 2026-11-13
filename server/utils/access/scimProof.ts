import { mintWorkspaceAccess } from '../../repos/proofs/mint'
import type { WorkspaceAccess, WorkspaceGrant } from '../../repos/proofs'

/**
 * A SCIM bearer token belongs to exactly one workspace's SSO connection and
 * administers that workspace's members (RFC 7644 provisioning). The proof
 * names the SCIM client as a system actor, so the audit trail tells it apart
 * from a person.
 */
export function proveScimWorkspace(workspaceId: string): WorkspaceAccess<WorkspaceGrant<'admin'>> {
  return mintWorkspaceAccess({ kind: 'system', name: 'scim' }, workspaceId, 'admin', 'admin')
}
