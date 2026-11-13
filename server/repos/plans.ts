import { eq } from 'drizzle-orm'
import { documents, users, workspaces } from '../db/schema'
import { useDatabase } from '../db/client'
import type { PersonalPlanName } from '~~/shared/config/tiers'

// Plan resolution inputs (server/utils/billing/entitlements.ts): which plan
// a user stores, who created a workspace, whose plan a document follows.
// Reference reads by bare id: every access decision and every
// rate / storage limit needs them, before or without any proof, and they
// return no content.

export async function getStoredUserPlan(userId: number): Promise<{ plan: PersonalPlanName, planValidUntil: Date | null } | null> {
  return (await useDatabase()
    .select({ plan: users.plan, planValidUntil: users.planValidUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0] ?? null
}

export async function getWorkspaceCreatorId(workspaceId: string): Promise<number | null> {
  const row = (await useDatabase()
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.workspaceId, workspaceId))
    .limit(1))[0]
  return row ? row.ownerId : null
}

/** The owner and workspace a document's plan follows (null when it doesn't exist). */
export async function getDocPlanSubject(docId: string): Promise<{ ownerId: number | null, workspaceId: string | null } | null> {
  return (await useDatabase()
    .select({ ownerId: documents.ownerId, workspaceId: documents.workspaceId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0] ?? null
}

/** The plan facts billing context resolution needs (period anchor included). */
export async function getUserPlanPeriod(userId: number): Promise<{ plan: PersonalPlanName, planValidUntil: Date | null, stripeCurrentPeriodStart: Date | null } | null> {
  return (await useDatabase()
    .select({ plan: users.plan, planValidUntil: users.planValidUntil, stripeCurrentPeriodStart: users.stripeCurrentPeriodStart })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0] ?? null
}

/** The stored plan and the id of the user's LiteLLM key (budget sync, spend lookups). */
export async function getUserPlanAndKeyId(userId: number): Promise<{ plan: PersonalPlanName, planValidUntil: Date | null, keyId: string | null } | null> {
  return (await useDatabase()
    .select({ plan: users.plan, planValidUntil: users.planValidUntil, keyId: users.litellmKeyId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0] ?? null
}
