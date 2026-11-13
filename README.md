<p align="center">
  <a href="./.github/media/markoto-demo.mp4">
    <img src="./.github/media/markoto-demo-poster.webp" alt="markoto: beautifully rendered Markdown. Click to watch the two-minute product tour." width="100%">
  </a>
</p>

<p align="center">
  <sub><b><a href="./.github/media/markoto-demo.mp4">Watch the two-minute tour</a></b> (MP4, 1080p, 1:59) ·
  Music by <a href="https://pixabay.com/users/poradovskyi-52868186/?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=511963">Andrii Poradovskyi</a> from <a href="https://pixabay.com/music//?utm_source=link-attribution&utm_medium=referral&utm_campaign=music&utm_content=511963">Pixabay</a></sub>
</p>

# markoto

**Beautifully rendered Markdown.** markoto is a collaborative Markdown editor
with a live, paginated preview. You write plain text on the left; the right
side lays it out as A4 or Letter pages while you type, and the PDF you export
matches that preview page for page.

**[Try it on markoto.app](https://markoto.app)**: no sign-up needed to start
writing. Or [host it yourself](#self-hosting) with one script.

[![CI](https://github.com/markoto-app/markoto/actions/workflows/ci.yml/badge.svg)](https://github.com/markoto-app/markoto/actions/workflows/ci.yml)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/markoto-app/markoto)](https://github.com/markoto-app/markoto/releases)

## What it does

- **Markdown beyond the basics**: GitHub-flavoured Markdown plus math (KaTeX), Mermaid diagrams, alerts, figures with captions, footnotes, `[[toc]]` and page breaks. The full syntax is in the [Markdown reference](./content/docs/writing/markdown-reference.md).
- **A paged preview that is the PDF**: one theme drives both the live preview ([paged.js](https://pagedjs.org)) and the server-rendered PDF, with running headers and footers, page numbers, a cover page and footnotes at the foot of the page.
- **Themes and custom CSS**: built-in design templates, adjustable colours, self-hosted fonts, page size, headers and footers; per-document custom CSS is sanitised on the server.
- **Real-time collaboration**: [Y.js](https://yjs.dev) documents synced through [Hocuspocus](https://tiptap.dev/hocuspocus), with presence, comments and an Activity Log that shows each change as a diff and restores any earlier state.
- **Workspaces and a knowledge base**: roles and email invitations; uploaded files are converted to Markdown, embedded and searched (vector plus full-text) so the AI can cite them.
- **An AI that edits with you**: the assistant joins the document as a collaborator and edits it through tools. Bring your own OpenAI-compatible key, or use the defaults the instance operator configures. Models and providers: [docs/AI-MODELS.md](./docs/AI-MODELS.md).
- **MCP server**: connect Claude Code, Cursor or your own script with a personal access token; see [Connect an AI agent](./content/docs/account/mcp.md).
- **Import and export**: import DOCX, PDF, PPTX, XLSX, HTML and EPUB; export PDF or plain `.md`.

## Self-hosting

The self-hosted instance runs the same code and images as markoto.app; what
differs is configuration. You need a Linux host with Docker Engine and the
Compose plugin **v5.0 or newer**, `openssl` and `curl`, and for HTTPS a domain
pointing at the host with ports 80 and 443 open.

```sh
git clone https://github.com/markoto-app/markoto.git markoto
cd markoto
./install.sh
```

`install.sh` asks for a domain (HTTPS through Let's Encrypt) or a plain-HTTP
port, the instance admins' email addresses, and optional sign-in and AI keys.
It generates the secrets, writes `.env`, pulls or builds the images, starts
the stack and waits until it is healthy. Every question has a flag for
unattended installs:

```sh
./install.sh -y --domain docs.example.org --acme-email ops@example.org --admin-email you@example.org
./install.sh -y --http-port 8080 --admin-email you@example.org
```

Upgrade with `git pull` (or `git checkout vX.Y.Z`) and `./install.sh upgrade`.
Sign-in providers (OpenID Connect, GitHub, Google), AI defaults, backups,
reverse proxies and troubleshooting are covered in
**[docs/SELF-HOSTING.md](./docs/SELF-HOSTING.md)**.

## Development

You need [Bun](https://bun.sh) 1.4 or newer, Docker with Compose 5.0 or newer
(or rootless Podman), `make` and `openssl`. No external accounts or API keys.

```sh
make setup      # .env with generated secrets, then bun install (one workspace: app, shared, sync-server, renderer)
make dev        # infra containers: Postgres, Valkey, SeaweedFS, LiteLLM, sync, markitdown, renderer
make dev-app    # the Nuxt app on the host, with hot reload
```

Open the URL Nuxt prints (usually `http://localhost:3000`); anonymous editing
works as is. `bun run test` runs the fast test tiers without Docker. Setup
details, the test tiers and the pull-request conventions are in
[CONTRIBUTING.md](./CONTRIBUTING.md); `make help` lists every workflow.

## Documentation

| Topic | Where |
|---|---|
| User guide (also served at `/docs` on every instance) | [content/docs/](./content/docs/) |
| Self-hosting | [docs/SELF-HOSTING.md](./docs/SELF-HOSTING.md) |
| Architecture | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| AI models and bring-your-own-key | [docs/AI-MODELS.md](./docs/AI-MODELS.md) |
| Security hardening | [docs/SECURITY-HARDENING.md](./docs/SECURITY-HARDENING.md) |
| Contributing | [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/contributing/](./docs/contributing/) |
| Reporting a vulnerability | [SECURITY.md](./SECURITY.md) |

## License

markoto is **source-available** under the
[Functional Source License 1.1 with an Apache 2.0 future license](./LICENSE)
(FSL-1.1-ALv2). In plain words:

- You may **use, self-host, modify and redistribute** it, for yourself, your team or your company, for any purpose except one.
- That exception: you may not offer it, or something substantially similar built from it, **as a competing commercial product or service**.
- **Each release becomes Apache 2.0** on the second anniversary of its publication, without that restriction.

More about the license at [fsl.software](https://fsl.software).

---

markoto is made by [LatentSpace Labs GmbH](https://markoto.app/legal/imprint), Zurich.
