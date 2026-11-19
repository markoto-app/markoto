# Changelog

All notable changes to markoto will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical release log lives in [GitHub Releases](https://github.com/markoto-app/markoto/releases).
Releases are opt-in: a merged pull request labelled `release:patch`, `release:minor` or
`release:major` produces one release, named and described from that PR's title and body,
with the version bumped from the latest tag. Unlabelled merges accumulate until the next
labelled one. See [CONTRIBUTING.md](./CONTRIBUTING.md#pull-requests) for the release labels.

This file no longer lists individual releases. Read the release notes on GitHub; the entry
below records the first public release.

## [0.1.0]: 2026-08-18

First public release of the markoto source tree.

markoto was developed in a private repository from April 2026; this release
opens the source under the [FSL-1.1-ALv2](./LICENSE) license. Everything
described in the README shipped before this point: the collaborative CRDT
editor, paged preview + server-rendered PDF export, workspaces with a
knowledge base, the AI writing assistant (EU-resident providers via a
self-hosted LiteLLM proxy), the MCP server, Stripe billing, and the
GDPR/DSA privacy infrastructure.
