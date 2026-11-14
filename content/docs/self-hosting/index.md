---
title: Run markoto yourself
description: Install markoto on your own Linux server with one script - what you get, what you need, and where the full guide lives.
category: self-hosting
order: 12
icon: i-lucide-server
updated: '2026-11-03'
---

# Run markoto yourself

markoto is source-available and designed to be self-hosted. The same code
that runs markoto.app runs on your own machine: collaborative editing,
paged preview and PDF export, workspaces and knowledge base, the MCP server,
and the AI assistant on providers you choose, including local models.

## What you need

- A Linux server with Docker and Docker Compose 5.0 or newer, about 6 GB of RAM and 15 GB of disk.
- For HTTPS: a domain pointing at the server, and ports 80 and 443 open.

## Install

```sh
git clone https://github.com/markoto-app/markoto.git markoto
cd markoto
./install.sh
```

The installer asks for a domain (or a plain-HTTP port), the email addresses
of the instance admins and, optionally, sign-in and AI keys. It generates all
secrets, starts everything and waits until the app is healthy.

## How a self-hosted instance differs

- **Sign-in is optional configuration.** Without it, the instance is anonymous-only: anyone can create, edit and share public documents and export PDFs, but nobody can own documents, use workspaces or AI.
- **AI works on your terms.** Users connect their own provider ([how](/docs/ai/provider)), or you set instance defaults, for example a local Ollama model. Nothing is sent to any AI provider unless someone uses an AI feature.
- **No plans, no billing.** Everyone is on the free tier with the limits you set ([plans and limits](/docs/plans/plans)).
- **No hosted-service legal pages.** The privacy policy, terms and cookie banner of markoto.app describe that service and are off by default. You are the operator of your instance.
- **Backups, upgrades and a re-embedding command** are built in.

## The full guide

Everything else (HTTPS and reverse proxies, sign-in setup, AI configuration,
every setting, backups and restore, upgrades, troubleshooting) is in the
[self-hosting guide](https://github.com/markoto-app/markoto/blob/main/docs/SELF-HOSTING.md).

## What's next

- [Use your own AI provider](/docs/ai/provider)
- [Connect Claude Desktop, Cursor or scripts](/docs/ai/mcp)
