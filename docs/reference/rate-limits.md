# Rate limits

The request limits the app and the sync server enforce, with the file each value comes from. Plan limits (workspaces owned, knowledge files and bytes, image storage, members) are not rate limits; they live in `shared/config/tiers.ts` and can be overridden per instance with `TIER_*` variables (`server/utils/billing/tierConfig.ts`).

## How limits work

- Limits are fixed-window counters in Valkey (`server/utils/platform/rateLimit.ts`). Each check is one Lua script, so a concurrent burst cannot overshoot.
- "Per client" means the client address as seen through `NUXT_TRUSTED_PROXY_HOPS` proxies: the IPv4 address, or the IPv6 /64 prefix (`getClientRateLimitKey` in `server/utils/platform/clientIp.ts`).
- Rate limits fail open when Valkey errors (they protect against abuse, not correctness). Single-session locks and in-flight slots (`tryAcquireSessionLock`, `reserveInflightSlot`) fail closed.
- With test mode active (`TEST_MODE=1` on an instance whose `NUXT_SITE_URL` is empty or loopback) rate limits are bypassed; `TEST_ENFORCE_RATE_LIMITS` turns chosen namespaces back on.
- An exceeded limit answers 429.

## Documents and files

| What | Limit | Source |
|---|---|---|
| Document token (`GET /api/docs/:id/token`) | 30 per client per minute | `server/api/docs/[docId]/token.get.ts` |
| Document password check | 5 per client and document per minute; 30 per document per minute; 30 failed attempts per document per hour lock the check | `server/utils/documents/docPasswordLimits.ts` |
| Anonymous document creation | 10 per client per hour and 30 per day | `shared/config/anonLimits.ts` |
| Anonymous-gate challenge | 60 per client per minute | `server/api/anon-gate/challenge.get.ts` |
| Document delete | 10 per client per minute | `server/api/docs/[docId]/index.delete.ts` |
| Share settings | 30 per user per 10 minutes | `server/api/docs/[docId]/share-settings/index.put.ts` |
| Publish a page | 30 per user per hour | `shared/config/publish.ts` |
| Published page files | 300 per client per minute | `server/api/published/[pageId]/[kind]/[file].get.ts` |
| Workspace brand files for a document | 300 per client per minute | `server/api/docs/[docId]/brand/[file].get.ts` |
| Document from a workspace template | 60 per user per hour | `server/api/workspaces/[wsId]/templates/[templateId]/documents.post.ts` |
| Import | 10 per client per minute | `server/api/import.post.ts` |
| Server-rendered PDF | 10 per client per minute (MCP render tools share it) | `server/utils/rendering/renderRateLimit.ts` |
| Preview image token (`GET /api/docs/:id/file-token`) | 60 per client per minute | `server/api/docs/[docId]/file-token.get.ts` |
| Image upload request / confirm | 60 each per user per minute | `server/api/upload/request.post.ts`, `server/api/upload/confirm.post.ts` |
| Knowledge upload request | 30 per user per minute | `server/api/workspaces/[wsId]/knowledge/upload-request.post.ts` |
| Design from a document (upload) | 10 per user per hour | `server/api/themes/from-document/upload-request.post.ts` |
| Brand kit upload | 60 per workspace per hour | `server/utils/brandKit/upload.ts` |

## Accounts and workspaces

| What | Limit | Source |
|---|---|---|
| Workspace invites | 20 per admin per hour, 30 per workspace per hour, at most 50 open invites per workspace, 3 invite emails per address per day | `server/utils/workspaces/workspaceInvites.ts` |
| Accept an invite link | 20 per user per 10 minutes | `server/api/user/invites/by-token.post.ts` |
| Log out everywhere | 10 per user per hour | `server/api/user/sessions/revoke.post.ts` |
| Account deletion request / cancel | 5 per user and client per hour | `server/api/user/delete.post.ts`, `server/api/user/delete-cancel.post.ts` |
| Data export request | 1 per user per day | `server/api/user/export.post.ts` |
| AI provider save / verify | 20 per user per 10 minutes | `server/api/user/ai-providers/[capability].put.ts` |
| Custom domain add / verify | 20 / 60 per user per hour | `server/api/user/custom-domains/` |
| Abuse report | signed in: 10 per user per hour; anonymous: 5 per client per hour and 20 per day | `shared/config/anonLimits.ts` |
| Consent record | 20 per client per 10 minutes | `server/api/consent.post.ts` |
| Waitlist sign-up | 5 per client per hour; 3 confirmation emails per address per day; confirm / unsubscribe 30 per client per 10 minutes | `server/api/waitlist/` |
| Billing checkout, top-up, portal, seats | 10 per user per minute | `server/api/billing/`, `server/api/workspaces/[wsId]/billing/` |
| Workspace audit export | 10 per user per hour | `server/api/workspaces/[wsId]/audit/export.get.ts` |
| SSO discovery | 20 per client per minute | `server/api/auth/sso/discover.post.ts` |
| SSO settings / domain verification | 20 / 30 per user per 10 minutes | `server/api/workspaces/[wsId]/sso/` |
| SCIM | 600 per connection per minute | `server/utils/sso/scim.ts` |

## AI and MCP

| What | Limit | Source |
|---|---|---|
| AI requests | 60 per minute per user virtual key, plus the key's `max_budget`, enforced by LiteLLM | `server/utils/litellm/userKeys.ts` |
| Web tools (`web_search`, `fetch_url`), editor AI and MCP together | 30 per user per hour and 100 per day; `NUXT_WEB_TOOLS_HOURLY_LIMIT` / `NUXT_WEB_TOOLS_DAILY_LIMIT`, `0` = unlimited | `server/utils/ai/webTools.ts` |
| Agentic loop | 50 interactions per session, plus per-tool call caps | `server/utils/agentic/limits.ts` |
| Live dictation | 1 session per user, 10 minutes per session, 30 s idle timeout | `server/routes/api/ai/dictate.ts` |
| MCP requests | 300 per client per minute, 240 per token per minute | `server/mcp/lib/mcpGate.ts` |
| MCP sessions | 60 new sessions per user per hour, at most 20 usable at once | `server/mcp/lib/mcpGate.ts` |
| MCP tool calls | 120 per user per minute; `generate_image` 20 per user per hour | `server/mcp/lib/mcpGate.ts` |

## Sync server

| What | Limit | Source |
|---|---|---|
| WebSocket connections | 20 per client address in production (200 otherwise); `SYNC_MAX_CONNECTIONS_PER_IP` | `sync-server/src/rate-limiter.ts` |
| Open documents per process | 5000 (joining a document that is already open is not limited) | `sync-server/src/rate-limiter.ts` |
| Message / update / document size | 17 MiB / 16 MiB / 16 MiB; `SYNC_MAX_MESSAGE_BYTES`, `SYNC_MAX_UPDATE_BYTES`, `SYNC_MAX_DOCUMENT_BYTES` | `sync-server/src/limits.ts` |

When either connection limit is reached, the sync server refuses with the reason `server-busy`: the editor shows "Server busy" and retries with backoff instead of reporting missing access.
