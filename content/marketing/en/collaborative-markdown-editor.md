---
title: Collaborative Markdown editor for teams
description: Edit Markdown together in real time - live cursors, comment threads, every change with a diff and restore, workspaces with roles. Free, or self-hosted.
keywords:
  - collaborative markdown editor
  - real-time markdown collaboration
  - shared markdown editor
  - markdown editor for teams
updated: '2026-11-04'
navGroup: use-cases
navLabel: Collaborative editing
navOrder: 30
---

# A collaborative Markdown editor

Send the link to a document and everyone who opens it edits the same text at the same time. You see each other's cursors and names, changes arrive as they are typed, and there is no save button and no merge conflict. Comments, a full history and workspaces with roles come with it.

::tour-clip{scene="collab"}
::

## Write at the same time

Two people can type in the same paragraph without overwriting each other: markoto merges the edits as they happen. The bar at the top shows who is in the document, and each person has a cursor in their own colour. This works without an account, too: an anonymous document can be edited by anyone with its link.

::flow-strip{id="two-writers-one-document" frames="07,10"}
::

## Discuss in comments

Select a passage and add a comment. The thread is anchored to those words and follows them when the text around them changes. Others reply under it, in a workspace you can mention members with `@`, and a resolved thread moves out of the way but stays readable. If the AI assistant is set up, `@markoto` in a comment asks it to answer or make the change.

::flow-strip{id="have-a-discussion" frames="11,15"}
::

## Every change, with a diff

The Activity tab lists every edit with who made it, when, and how many lines changed. Open an entry to see the diff. Comments, title and theme changes and the AI's edits are in the same list. **Restore** puts the document back to how it was just before a change, for everyone, and the restore is itself listed, so it can be undone too.

::flow-strip{id="see-what-changed-in-past-edits" frames="05"}
::

::flow-strip{id="restore-an-earlier-version" frames="09"}
::

More in the docs: [see what changed](/docs/history/see-changes) and [restore an earlier version](/docs/history/restore).

## Workspaces and roles

A workspace holds a team's documents. You invite people by email, and they join when they accept. There are three roles: **admins** manage members and the workspace, **editors** write and comment, **viewers** read. A workspace always keeps at least one admin.

::flow-strip{id="roles-inside-a-workspace" frames="08" caption="The members panel: each person has a role, and an admin changes it from the chip beside the name."}
::

Documents outside a workspace are shared by link. The owner picks one of four modes: private, anyone with the link can edit, anyone with the link can view, or protected by a password. See the [sharing docs](/docs/sharing) and [workspace docs](/docs/workspaces).

## The AI is a collaborator you can see

When the AI assistant edits a document, it joins like another person: its cursor and its changes show up live for everyone, in markoto's red, and its edits are in the history like anyone else's. You can restore what it changed. The AI needs an account; on markoto.app it runs on a small monthly allowance or on [your own AI provider](/docs/account/ai-provider).

## What it doesn't do

- **No suggestion mode.** There are no tracked changes to accept or reject. People with edit access change the text directly, and the history keeps every version.
- **No offline mode.** A document needs a connection to open. A short drop while you type is fine: your edits sync when you're back.
- **Markdown, not a word processor.** Everyone edits the Markdown source; the paged preview sits next to it.

## Run it for your team

markoto can run on your own server, with sign-in through your company's identity provider. See [self-hosting markoto](/self-hosted-markdown-editor).

Choosing between tools? See markoto next to [HackMD](/compare/hackmd), [HedgeDoc](/compare/hedgedoc) and [Google Docs](/compare/google-docs). The free plan's limits are on the [pricing page](/pricing).

## Questions

::faq{json-ld}
---
items:
  - q: Is real-time collaboration free?
    a: Yes. Live co-editing, comments and history are part of the free plan on markoto.app, and anonymous documents can be edited together without an account.
  - q: How many people can edit a document at once?
    a: There is no per-document limit on collaborators. Anyone with an edit link, or with an editor role in the workspace, can join.
  - q: Do collaborators need an account?
    a: Not for a document shared with an edit or view link. To join a workspace, a person needs an account with the invited email address.
  - q: Can I see who changed what?
    a: Yes. The Activity tab lists every change with the author and time, shows the diff, and can restore the document to how it was before any change.
  - q: Is there a suggestion or track-changes mode?
    a: No. Edits go straight into the text. The history keeps every version, so a change can be reviewed and undone afterwards.
  - q: Can we host it ourselves?
    a: Yes. markoto installs on a Linux server with Docker Compose and one script, with sign-in through your own OpenID Connect provider.
---
::

::cta{title="Write together, starting now." secondary-label="Read the collaboration docs" secondary-to="/docs/workspaces/live-collab"}
Create a document and send the link. Your collaborator doesn't need an account.
::
