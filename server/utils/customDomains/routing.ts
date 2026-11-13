import { listOnceVerifiedHostnames, listVerifiedCustomDomains } from '../../repos/customDomains'
import { planHasFeature, resolveUserPlan } from '../billing/entitlements'
import { customDomainSettings } from './config'

// Which custom domains are live: verified, and their owner's plan
// still includes custom domains, a downgrade takes them off the routing
// table (nothing is deleted; they come back with the plan). A domain
// whose owner can no longer manage the attached document stays live but
// shows nothing (`pageId` null) until the right returns or the owner
// attaches another page. Shared by the
// Traefik provider endpoint, the host middleware and the canonical URL of
// a page. Cached briefly: the middleware asks on every request to a host
// that isn't the instance's own.

export interface LiveCustomDomain {
  id: string
  hostname: string
  pageId: string | null
}

const TTL_MS = 15_000
interface Snapshot {
  byHost: Map<string, LiveCustomDomain>
  /** Hostnames that were verified at some point, live or not. */
  known: Set<string>
}
let cache: ({ at: number } & Snapshot) | null = null
let inflight: Promise<Snapshot> | null = null

async function load(): Promise<Snapshot> {
  const byHost = new Map<string, LiveCustomDomain>()
  if (!customDomainSettings()) return { byHost, known: new Set() }
  const planOk = new Map<number, boolean>()
  for (const d of await listVerifiedCustomDomains()) {
    if (!planOk.has(d.userId)) planOk.set(d.userId, planHasFeature(await resolveUserPlan(d.userId), 'customDomains'))
    if (planOk.get(d.userId)) byHost.set(d.hostname, { id: d.id, hostname: d.hostname, pageId: d.pageManageable ? d.pageId : null })
  }
  return { byHost, known: await listOnceVerifiedHostnames() }
}

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache
  inflight ??= load().then((snap) => {
    cache = { at: Date.now(), ...snap }
    return snap
  }).finally(() => {
    inflight = null
  })
  return inflight
}

export async function liveCustomDomains(): Promise<Map<string, LiveCustomDomain>> {
  return (await snapshot()).byHost
}

/** Forget the cache after a change made by this instance (others catch up within the TTL). */
export function invalidateCustomDomainCache(): void {
  cache = null
}

export async function liveCustomDomainForHost(host: string): Promise<LiveCustomDomain | null> {
  return (await liveCustomDomains()).get(host) ?? null
}

/** Was `host` ever a verified custom domain (live or not)? */
export async function isKnownCustomHostname(host: string): Promise<boolean> {
  return (await snapshot()).known.has(host)
}

/** `https://<domain>/` of the live domain showing `pageId`, if any. */
export async function customDomainUrlForPage(pageId: string): Promise<string | null> {
  for (const d of (await liveCustomDomains()).values()) {
    if (d.pageId === pageId) return `https://${d.hostname}/`
  }
  return null
}
