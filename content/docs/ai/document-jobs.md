---
title: Translate or restyle a whole document
description: Translate, change the tone or update the terms of many sections at once. The AI runs it in the background, and you can cancel or undo the whole job.
category: ai
order: 5
updated: '2026-11-18'
---

# Translate or restyle a whole document

Some changes apply to every section in the same way: translate chapters
2 to 5 into English, make the whole manual less formal, use the new
product terms everywhere. For these the AI starts a **background edit**.
It tries the change on a few sample sections first, then works through
the sections one by one while you keep writing, and you can undo the
whole thing in one step afterwards.

::flow{id="translate-many-sections-with-ai" hide-title}
::

## What you can ask for

Ask in the prompt bar as usual and say which part of the document the
change is for: *Translate sections 2 to 5 into English*, *Rewrite the
whole document in a friendlier tone*, *Add a short summary under every
chapter heading*. Typical background edits:

- **Translation** into another language.
- **Rewrite**: tone, register, shortening or copy-editing, section by section.
- **Terminology**: new names or terms used consistently, with the grammar around them adjusted.
- **Summaries**: one summary per chapter.

Code samples, math, link addresses and the headings' structure stay as
they are. You don't have to ask for a background edit: the AI decides
from your request and the size of the part you want changed. A change to
a few sections, or to less than roughly 15 pages of text, it simply makes
itself, like any other edit.

## Before it starts: the estimate

The AI tries the change on a sample first. Then a card above the prompt
bar asks before anything changes, with the number of sections and the
expected time, for example *Translate 4 sections to English, about 1 min
(about 3 % of this month's AI allowance).* With your own AI provider it
shows an estimate in tokens instead, since your provider bills you.

In the editor's prompt bar the card always asks. When a job is started where nobody can be asked right away (an `@markoto` comment or a connected app), a small job starts at once and only a larger one asks first: more than 30 parts, more than about $0.05, or more than a tenth of what is left of your AI allowance.

- **Start** runs the edit.
- **Cancel** changes nothing. You can type a short note first (*"only chapter 3"*), and the AI follows it instead.
- No answer within about a minute and a half counts as Cancel.

If the estimate is more than what is left of your AI allowance, nothing
starts and the AI offers to do a part of the document instead.

## While it runs

A **Background edit** panel above the prompt bar shows the progress: how
many parts are done out of the total and the heading being worked on.
Collaborators see markoto working in the document and
the sections changing as they are finished; only you see the panel.

- **You can close the tab.** The edit keeps running on the server. When you open the document again, the panel shows where it stands.
- **Cancel** stops it. Sections already finished stay changed (you can undo them, see below); the part in progress is dropped. Once every part is done, Cancel disappears while the edit finishes.
- **Resume** continues a cancelled edit with the parts that are left. It also appears when an edit was paused because your AI allowance ran out, or interrupted by a server problem.
- **Sections someone edits while the job runs are left alone.** If a section changed after the job started, the job doesn't overwrite it.

When it is finished the panel says how many parts were changed, how many
were left as they were (for example because someone edited them in the
meantime) and how many need a look from you. Close the panel with its
**×** button.

Your plan can limit how many background edits you start a day and how
many sections one edit may cover; markoto tells you when you hit a
limit. You can run one background edit at a time.

## Undo an AI job

A background edit is undone as a whole, not edit by edit. The Activity
tab shows it as *started a large AI edit* and, when it is finished,
*finished a large AI edit* with the number of parts it changed.

1. Open the **Activity** tab.
2. Click **Undo job** on the job's entry.
3. Confirm with **Undo** (*Restore what this job changed?*), or keep it with **Keep**.

markoto puts back the original text of every section the job changed.
Fixes markoto made to those sections in the same request, right after
the job (for example making a term consistent across chapters), count as
part of the job and are undone with it.
**Sections someone edited after the job are left as they are**, so
undoing never throws away later work by you or a collaborator. A message
tells you how many parts were restored, and names the parts that stayed
and why (edited since, deleted, or older than 7 days). The Activity tab
records *undid a large AI edit*.

- The person who started the job can also press **Undo job** in the progress panel.
- Anyone who can edit the document can undo a job from the Activity tab.
- Undoing a job that is still running stops it first.
- The original text is kept for 7 days; after that a job can no longer be undone this way, but you can still [restore an earlier version](/docs/import-export/restore) of the document.

## What's next

- [Work with long documents](/docs/ai/long-documents): questions about one section and renames across the whole document.
- [Restore an earlier version](/docs/import-export/restore): roll the whole document back to any point.
- [AI Points and what happens when you run out](/docs/plans/ai-budget).
