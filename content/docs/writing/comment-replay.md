---
title: Replay a comment in its original context
description: Click any old comment in the activity log — markoto opens the doc at that exact passage as it was when the comment landed.
category: writing
order: 13
---

# Replay a comment in its original context

Comments outlive the prose they were attached to — someone fixes a
typo, deletes a paragraph, the conversation about that paragraph still
shows up in the activity log. Replay opens the comment with the
surrounding text restored to whatever it said the moment the comment
was posted, so you can read the discussion in context.

::flow{id="replay-a-comment-in-its-original-context" hide-title}
::

## What just happened

Each comment activity row carries a Y.js snapshot pointer. Clicking
"Open in context" replays the doc state up to that snapshot using the
same `historyReplay.ts` machinery that drives version restore — but
instead of restoring, it renders a side-by-side view: the original
passage on the left, the comment thread on the right, the present-day
doc still safely behind both.

Closing the dialog returns you to the live doc. Nothing was changed.

## What's next

- [See what changed in past edits](/docs/history/see-changes) — same machinery, applied to edits instead of comments.
- [Restore an earlier version](/docs/history/restore) — when you want to actually roll back, not just look.
