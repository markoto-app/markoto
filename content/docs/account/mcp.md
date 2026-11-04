---
title: Connect Claude Desktop, Cursor or scripts (MCP)
description: Create a personal access token and let any MCP client read and edit your documents, with live edits visible to collaborators.
category: account
order: 7
icon: i-lucide-plug
updated: '2026-11-04'
---

# Connect Claude Desktop, Cursor or scripts (MCP)

markoto runs an **MCP server** at `/mcp` (for example `https://markoto.app/mcp`).
MCP is the protocol that apps like Claude Desktop, Cursor and your own
scripts use to call tools. Connected to markoto, such an app can read and edit
your documents with the same tools markoto's built-in AI uses, and
collaborators watch the edits arrive live.

The AI in the MCP client is your client's own; markoto's writing assistant
and AI provider settings are not involved. You need to be signed in to
create a token. The server is part of every instance, including self-hosted
ones.

## Create a token

1. While signed in, open your profile menu (your avatar, top right) and choose **Integrations (MCP)**. The page lives at `/settings/integrations` on your instance (for example `https://markoto.app/settings/integrations`).
2. Type a name that tells you where it will live ("Claude Desktop on laptop") and press **Generate**.
3. **Copy the token now.** It starts with `mkt_` and is shown exactly once; markoto only stores a hash and can't recover it. If you lose it, revoke it and create a new one.

The page also shows a ready-made config snippet with your token filled in:

```json
{
  "mcpServers": {
    "markoto": {
      "url": "https://markoto.app/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Put it in your client's MCP configuration. The exact file and the way a client
accepts a remote server with a header differ between clients and versions, so
follow your client's own MCP documentation, and use the URL and the
`Authorization: Bearer ...` header from above. In Claude Code, for example,
adding a remote server looks like
`claude mcp add --transport http markoto https://markoto.app/mcp --header "Authorization: Bearer <your-token>"`.

## What a token can do

A token acts as you, limited to its scopes. New tokens get all four:

| Scope | Allows |
|---|---|
| `documents:read` | List your documents, read them, comments, themes, activity, page images, export as markdown or PDF |
| `documents:write` | Create, edit and duplicate documents, set titles, change themes, save theme presets, add, reply to, resolve and delete comments, generate images into a document (image generation also needs an image provider under your [AI provider settings](/docs/account/ai-provider) or an instance default) |
| `knowledge:read` | Search and read knowledge files in workspaces you belong to |
| `web:fetch` | Web search and URL reading |

A token can never exceed your own access: it can't edit a document you can't
edit, or read a workspace you aren't in. Tools for a scope the token lacks
are not even listed to the client, and every call is checked again. Web
search and URL reading share the same allowance as the in-app AI (30 per
hour and 100 per day by default) and exist only if the instance has those
providers set up.

Image generation needs `documents:write`. A token limited to `web:fetch`
without `documents:write` doesn't offer image generation; create a new
token if you need it.

## Limits

- Every request needs a valid token; without one the server answers with
  an error and keeps no connection state.
- A connection (MCP session) belongs to the token that opened it and can't
  be used with another token.
- Calls are rate-limited per token and per account (120 tool calls a
  minute). An account keeps up to 20 connections at once; opening one more
  closes the one used least recently, and the client reconnects.
- Rendering (PDF export, page count, page images) shares the allowance of
  the PDF download in the editor, 10 renders a minute. Image generation is
  limited to 20 an hour.

Your MCP client is your own agent, so markoto doesn't ask you to confirm
its tool calls the way the [in-editor AI does](/docs/writing/ai-prompt-bar#when-the-ai-asks-first);
your client's own confirmation settings apply.

## Where edits show up

Edits made through MCP appear live in the editor like any collaborator's.
The [activity log](/docs/history) marks them as made by your MCP client
("Claude Desktop", "Cursor", ...) on your behalf, so you can tell them apart
from your own typing and [restore an earlier version](/docs/history/restore)
if you don't like a result.

## Managing and revoking tokens

The Integrations page lists active tokens with when they were created and
last used. **Revoke** a token the moment it leaks or you retire a device; it
stops working right away. You can have up to 20 active tokens.

Treat a token like a password: it grants access to everything it is scoped for
until it is revoked.

## What's next

- [What the AI can do, and what it needs](/docs/writing/ai-overview)
- [Delete your account](/docs/account/delete-account): removes your tokens too.
