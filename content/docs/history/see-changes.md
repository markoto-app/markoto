---
title: See what changed in past edits
description: Click any activity row — markoto opens a diff drawer with hunk-level highlights of what was added and removed.
category: history
order: 1
featured: true
---

# See what changed in past edits

Every edit to a doc lands as a row in the activity log — title
changes, theme changes, content edits, comments, restores. Click any
edit row and a diff drawer opens with hunk-level highlights:
red strikethroughs for what came out, green for what went in.

::flow{id="see-what-changed-in-past-edits" hide-title}
::

## What just happened

Each activity row carries two Y.js snapshot pointers — `before` and
`after`. The diff endpoint replays the doc to those two boundaries,
runs `structuredPatch` from the `diff` library, and returns the
hunks. The drawer renders them with author colour, line numbers,
and surrounding context.

Diff output is capped at 200 hunks — pathological diffs (a paste
that replaces the whole doc, a scripted bulk rename) would otherwise
make the drawer unusable. Past the cap, the drawer shows a "see
restore for full content" footer.

## What's next

- [Restore an earlier version](/docs/history/restore) — rewind to that exact state.
- [Replay a comment in context](/docs/writing/comment-replay) — same machinery, applied to comment threads.
