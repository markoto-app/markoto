---
title: Suggest and review changes
description: Propose changes instead of making them, then accept or reject each one. Like suggesting in Google Docs or tracked changes in Word.
category: collaborate
order: 4
updated: '2026-11-19'
---

# Suggest and review changes

In Suggesting mode your changes don't go into the text. They show up
as proposals: what you add is underlined in your colour, what you
delete is struck through. The people who edit the document accept or
reject each one. Use it to review a colleague's draft, or ask for it
when someone else reviews yours, like a supervisor going through a
thesis chapter.

::flow{id="suggest-and-review-changes" hide-title}
::

## Switch to Suggesting

Click **Editing** in the top bar to switch to **Suggesting**, and back.
While you suggest:

- typing adds a suggestion at the caret; keep typing and it grows;
- deleting strikes the text through instead of removing it;
- selecting text and typing over it proposes a replacement;
- Backspace right after your own suggested text takes it back letter
  by letter;
- Ctrl+Z (Cmd+Z) undoes your suggestions like any other change.

The status bar says **suggesting** while you are in this mode.

## Review suggestions

Open the **Suggestions** panel in the right sidebar (the count on its
button tells you how many are open), or click a suggestion in the text.
On a phone, tap the suggestion: its card opens at the bottom of the
screen.

Each card shows who suggested what and when. **Accept** puts the change
into the text, recorded as an edit of the person who suggested it.
**Reject** discards it. **Accept all** and **Reject all** decide every
open suggestion at once; pick a person in the list above them to decide
only theirs.

Every card has a **Reply** button for a short discussion. The thread is
closed when the suggestion is accepted or rejected. If you made the
suggestion yourself and can't accept it, **Withdraw** removes it.

When the text under a suggestion changed after it was made, the card
says so. Accepting then applies the suggestion to the text as it is
now. If someone deleted the whole passage, the card says there is
nothing left to change: reject it to clear it.

Accepting and rejecting appear in the activity log. **Restore** on an
"accepted a suggestion" entry takes the change back out.

## Require suggestions

In the share dialog (the lock in the top bar), the owner and workspace
admins can turn on **Everyone suggests changes**. From then on, people
who open the document can only suggest; they can't edit the text, the
title, the theme or the references. They can still cite a work that is
already in the references: the citation becomes a suggestion. The owner
always edits directly. In a workspace
document you choose whether workspace admins and editors keep editing
directly too.

**Viewers can suggest** lets signed-in people who may only view the
document suggest changes and reply to suggestions. People without an
account stay read-only.

## Let the AI suggest

Turn on **The AI suggests instead of editing** in Settings, AI, or use
the suggestion switch in the AI bar for one prompt. The AI's changes,
also those of a long background edit, then arrive as suggestions for
you to accept or reject. Undoing a background edit removes the
suggestions nobody decided yet. Where a document requires suggestions
of you, the AI always suggests on your behalf. The same goes for changes
the AI makes to your [AI context documents](/docs/ai/project-context):
they arrive there as suggestions.

## What prints and exports

Preview, PDF, published pages and the Markdown download contain the
accepted text only. To hand the suggestions to someone else, use the
download button in the Suggestions panel: it saves the Markdown with
every open suggestion written in CriticMarkup (`{++added++}`,
`{--deleted--}`, `{~~old~>new~~}`), which many Markdown tools can read.

## What's next

- [Discuss in your document](/docs/collaborate/comments): comment on a passage instead of changing it.
- [See what changed](/docs/import-export/see-changes): the activity log and restoring an earlier state.
