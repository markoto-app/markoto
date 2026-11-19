---
title: Guests in a workspace
description: Invite clients and freelancers as guests. They see only the documents you share with them, take no seat and use their own AI budget.
category: workspaces
order: 5
updated: '2026-11-09'
---

# Guests in a workspace

> **Availability.** On markoto.app guests are part of the **Team** and
> **Business** plans (coming soon), up to five guests per paid seat. On a
> self-hosted instance every workspace can have guests.

A guest is someone outside your team (a client, a freelancer, a reviewer)
who works on some of your documents but shouldn't see the rest of the
workspace. A guest:

- sees **only the documents shared with them**, under **Shared with you** on
  their home page, not the workspace page, its other documents, its members
  or its knowledge base;
- can view or edit each shared document, as you choose per document;
- **takes no seat** and isn't counted as a member;
- uses **their own AI budget** (or their own AI key), never the workspace's;
- signs in the usual way, also when the workspace requires
  [single sign-on](/docs/workspace-admin/single-sign-on): guests are outside your
  organisation's identity provider.

## Invite a guest

Workspace admins open **Members**, type the person's email address and choose
the role **Guest**. The guest accepts the invitation like any other: on their
home page, or through the link in the email.

## Share a document with a guest

Admins and editors of the workspace open the document's share dialog. Under
**Guests**, choose the guest and **Can view** or **Can edit**, then **Share**.
Change the access or click **×** to stop sharing at any time; an open
document closes for the guest straight away.

::flow{id="share-a-document-with-a-guest" hide-title}
::

A guest can't share a document further. Sharing ends on its own when the
document moves to another workspace, or when the guest leaves or is removed
from the workspace. Every share and unshare is recorded in the workspace's
[audit log](/docs/workspace-admin/audit-log).

## Usage per person

Admins find a **Usage** tab on the workspace page: per person, the documents
they own in the workspace, the knowledge files and images they added, and
(on a Team or Business plan) their AI spend on the shared budget this
period. Guests are listed with the number of documents shared with them.
The tab shows usage, not activity: nothing about when or how often anyone
works.

## What's next

- [Team and Business for a workspace](/docs/plans/team-plan).
- [Audit log of a workspace](/docs/workspace-admin/audit-log).
