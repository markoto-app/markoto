import { Resolver } from 'node:dns/promises'
import { customDomainVerifyName, customDomainVerifyValue, type CustomDomainDnsProblem } from '~~/shared/config/customDomains'

// DNS check of a custom domain. Two things must hold:
//  1. ownership: a TXT record `_markoto-verify.<host>` = `markoto-verify=<token>`
//     (the token is per domain row, so a record left from someone else's
//     earlier claim proves nothing for a new one);
//  2. routing: the host is a CNAME to the instance's target, or, for an
//     apex domain, which can't carry a CNAME, resolves to exactly the
//     target's addresses (ALIAS / CNAME flattening).
// Only then does the domain get a router and a certificate.

export interface DnsLookups {
  resolveTxt: (name: string) => Promise<string[][]>
  resolveCname: (name: string) => Promise<string[]>
  resolve4: (name: string) => Promise<string[]>
  resolve6: (name: string) => Promise<string[]>
}

export function dnsLookups(servers: string[]): DnsLookups {
  const r = new Resolver({ timeout: 4000, tries: 2 })
  if (servers.length > 0) r.setServers(servers)
  return {
    resolveTxt: n => r.resolveTxt(n),
    resolveCname: n => r.resolveCname(n),
    resolve4: n => r.resolve4(n),
    resolve6: n => r.resolve6(n)
  }
}

export type DnsCheck = { ok: true } | { ok: false, problem: CustomDomainDnsProblem }

const NOT_FOUND = new Set(['ENODATA', 'ENOTFOUND', 'ENONAME', 'NXDOMAIN'])

/** `fn()` with "no such record" as an empty list; other errors throw. */
async function records<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn()
  } catch (e) {
    if (NOT_FOUND.has((e as { code?: string }).code ?? '')) return []
    throw e
  }
}

const bare = (name: string) => name.toLowerCase().replace(/\.$/, '')

export async function checkCustomDomainDns(hostname: string, token: string, target: string, dns: DnsLookups): Promise<DnsCheck> {
  try {
    const txt = (await records(() => dns.resolveTxt(customDomainVerifyName(hostname)))).map(parts => parts.join(''))
    if (txt.length === 0) return { ok: false, problem: 'txt-missing' }
    if (!txt.includes(customDomainVerifyValue(token))) return { ok: false, problem: 'txt-mismatch' }

    const cnames = (await records(() => dns.resolveCname(hostname))).map(bare)
    if (cnames.includes(bare(target))) return { ok: true }
    if (cnames.length > 0) return { ok: false, problem: 'not-pointing' }

    // No CNAME: compare addresses with the target's.
    const [hostV4, hostV6, targetV4, targetV6] = await Promise.all([
      records(() => dns.resolve4(hostname)),
      records(() => dns.resolve6(hostname)),
      records(() => dns.resolve4(target)),
      records(() => dns.resolve6(target))
    ])
    const host = new Set([...hostV4, ...hostV6])
    const ours = new Set([...targetV4, ...targetV6])
    if (host.size > 0 && ours.size > 0 && [...host].every(a => ours.has(a))) return { ok: true }
    return { ok: false, problem: 'not-pointing' }
  } catch {
    return { ok: false, problem: 'lookup-failed' }
  }
}
