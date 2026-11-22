---
title: Navigate with the outline
description: Jump to any heading of a long document and switch to another document of your workspace from the panel on the left.
category: writing
order: 8
updated: '2026-11-22'
---

# Navigate with the outline

The panel on the left of the editor has two tabs. **Outline** lists the
headings of the document you are writing, with sections nested under their
chapters. **Workspace** lists the other documents of the workspace, in
their folders, so you can switch without going back to the workspace page.

This walkthrough jumps around a long report and then opens another document
of the same workspace. About a minute.

::flow{id="navigate-with-the-outline" hide-title}
::

## What you can do

- **Open and close the panel** with the panel button at the left end of the
  toolbar, under **View › Outline and documents**, or with
  <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd> (<kbd>Cmd</kbd> +
  <kbd>Shift</kbd> + <kbd>E</kbd> on a Mac).
- **Jump to a heading:** click it in the outline. The cursor goes to the end
  of the heading, and the editor and the preview both scroll to it.
- **See where you are:** the outline marks the section the cursor is in and
  follows you as you scroll.
- **Collapse a chapter** with the arrow next to it. A click on the heading
  itself always jumps.
- **Switch documents:** click a document in the Workspace tab to open it
  here; <kbd>Ctrl</kbd> + click (<kbd>Cmd</kbd> + click on a Mac) or a
  middle click opens it in a new tab. **Open in workspace** at the top of
  the tab takes you to the full document list.
- **From the keyboard:** in the outline and in the document list, the arrow
  keys move between entries, <kbd>Right</kbd> and <kbd>Left</kbd> open and
  close a section, and <kbd>Enter</kbd> jumps to the heading or opens the
  document.

Only real headings show up: a line starting with `#` inside a code block or
a hidden comment is not one, and the metadata block some Markdown files
start with (`---` … `---`) is left out.

For a document outside any workspace, the Workspace tab lists your own
documents. If someone shared a single document of their workspace with
you, the tab lists only the documents shared with you there.

On a wide screen the panel sits next to the editor and starts open the
first time; on a smaller one it lies over the editor while you use it. Your
choice (open or closed, and the last tab) is remembered in this browser.
On a phone, open **Outline and documents** from the menu at the top right.
