---
title: Markdown meeting notes template
description: A Markdown meeting notes template with agenda, decisions, action items with owners, and open questions. Write it together live and share it as a PDF.
keywords:
  - markdown meeting notes template
  - meeting minutes markdown
  - meeting notes template
  - action items template
updated: '2026-11-04'
navGroup: templates
navLabel: Meeting notes template
navOrder: 30
---

# Markdown meeting notes template

Good meeting notes answer three questions a week later: what was decided, who does what by when, and what is still open. This template has a section for each, plus the agenda and a short record of the discussion.

Here it is filled in for a made-up weekly meeting. Edit it to see the pages change.

::try-it{theme="modern" height="640"}
---
source: |
  # Weekly product sync

  **Date:** 2026-11-04\
  **Attendees:** Priya, Jonas, Mei, Tomás\
  **Purpose:** Decide whether the export feature ships this month

  ## Agenda

  - Export feature: status and go/no-go (15 min)
  - Support tickets from last week (10 min)

  ## Discussion

  ### Export feature

  The PDF export passes all tests except long tables, which split badly on Letter paper. Jonas has a fix in review. Mei asked whether we need a beta label; nobody thought so.

  ### Support tickets

  31 tickets, down from 44. Most were about password reset emails landing in spam.

  ## Decisions

  - Ship the export feature on 18 November, without a beta label.
  - Move the password reset emails to the new sending domain this week.

  ## Action items

  - [ ] Jonas: merge the long-table fix (7 Nov)
  - [ ] Mei: write the release note (14 Nov)
  - [ ] Tomás: switch the sending domain (8 Nov)

  ## Open questions

  - Do we announce the export by email or only in the changelog? (Priya)
---
::

::cta{title="Start your next meeting from this template." label="Use this template" template="meeting-notes" theme="modern" secondary-label="All templates" secondary-to="/templates"}
Opens the new-document dialog with the meeting notes template selected. It starts with the same headings and a note in each section saying what goes there.
::

## What's in it

- **Date, attendees and purpose.** Three lines at the top. The purpose is one sentence, such as "Decide whether to ship X by Y".
- **Agenda.** The topics in order, with a time box if the meeting is tight.
- **Discussion.** One subheading per agenda item: what was raised and what concerns came up, not a transcript.
- **Decisions.** One bullet per decision. A deferred topic is written down as deferred.
- **Action items.** A task list in the form `- [ ] Owner: action (due date)`. Every item has an owner.
- **Open questions.** What needs an answer before the next meeting, and who chases it.

The template itself is the empty outline. The grey notes under each heading say what goes there and never show in the preview or the PDF.

::flow-strip{id="start-from-a-template" frames="16" caption="A new document from the meeting notes template: the headings are in place, and the grey notes in the editor say what to write in each section."}
::

## Who it's for

Teams that keep notes in a shared document during the meeting. Everyone with the link can type at the same time and sees the others' cursors. Afterwards, share the link read-only or send the PDF to people who weren't there.

## Working with it

- **Write together.** Open the document on the shared screen and let each person add their own action items.
- **Tick off the tasks.** Change `[ ]` to `[x]` when an item is done; the preview shows it checked.
- **Keep a series.** With an account, duplicate last week's notes (**File › Duplicate…**) to keep the attendees and standing agenda items.
- **See who changed what.** The activity log lists every edit, and any earlier state can be restored.
- **Ask the AI for a summary.** With an account, the writing assistant can turn the discussion into a short summary for people who missed the meeting.

## Questions

::faq{json-ld}
---
items:
  - q: Can several people write the notes at the same time?
    a: Yes. Everyone with the link edits the same document live, with their own cursor. With an account you can also invite people into a workspace.
  - q: How do I send the notes to people who weren't there?
    a: Share the link read-only, or download the PDF with File › Export › PDF and send that.
  - q: Do the action items sync with a task tracker?
    a: No. They are a Markdown task list inside the document; there is no integration with Jira, Asana or similar tools.
  - q: Is there a template for recurring meetings?
    a: Use the same template each time, or, with an account, duplicate the previous meeting's document so the attendees and standing agenda items carry over.
---
::

::cta{title="Notes everyone can write at once." label="Use this template" template="meeting-notes" theme="modern"}
Free on markoto.app, no sign-up needed.
::
