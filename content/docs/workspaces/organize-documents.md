---
title: Organize documents in folders
description: Folders, drag and drop, right-click menus, keyboard shortcuts and search for your documents and a workspace's.
category: workspaces
order: 2
updated: '2026-11-18'
---

# Organize documents in folders

Your own documents (**My documents** on the home page) and every
workspace's **Documents** tab work like the file manager on your
computer: the folder tree on the left, the open folder on the right, the
path to it above the list. Folders can hold folders. Each folder has its
own address, so you can bookmark it, send the link to a teammate, and the
browser's Back and Forward buttons go through the folders you opened. The
sort order and a search are part of the address too.

## Folders, moving and search

::flow{id="organize-a-workspace" hide-title}
::

- **Create a folder:** **New → New folder**, type its name, press Enter.
  To make one inside another folder, open that folder first, or
  right-click the folder and pick **New folder**.
- **Rename:** select the item and press **F2**, click its name a second
  time, or right-click and pick **Rename**. Enter saves, Escape cancels.
  Renaming a document changes its title everywhere, also for people who
  have it open.
- **Move:** drag documents and folders onto a folder in the list, a folder
  in the tree or a part of the path above the list. Hold a dragged item
  over a folder for a moment and it opens, so you can drop it deeper
  down. **Move to...** in the right-click menu does the same without
  dragging. Press **Ctrl+Z** (Cmd+Z on a Mac), or click **Undo** in the
  note that appears, to put the last move back.
- **Select several:** Ctrl-click (Cmd-click on a Mac) adds or removes one
  item, Shift-click selects everything between, Ctrl+A selects the whole
  folder. A bar at the bottom of the list shows the count; **Actions** in
  it works on all of them at once.
- **Search:** the search box finds documents by title and by any word in
  their text, in the open folder. Tick **All folders** to search the whole
  workspace (or all of My documents). To search everything you can open
  (your documents, every workspace and documents shared with you), press
  **Ctrl+K** (Cmd+K) or click **Search documents**.
- **Sort:** by last edited, created, last activity or name, ascending or
  descending.
- **Import:** drop files or a whole folder from your computer onto the
  list, or use **New → Import files...**. See
  [Import many files at once](/docs/import-export/bulk-import).

### Move documents to another workspace

**Move to...** on one or more documents has a second tab, **To another
workspace**, which lists the workspaces where you are an editor or admin,
and **My documents**. The members of the new workspace can see the
documents from then on, and the members of the old one can't any more.
Folders stay in their workspace; move the documents out of them.

## Right-click menus

::flow{id="explorer-context-menu" hide-title}
::

Right-click a document, a folder, a selection or the empty space below
the list. Each gets the actions that fit: a document can be opened in a
new tab, renamed, moved, cut, duplicated, shared, its link copied or
deleted; a folder can also get a new document, folder or import inside
it; the empty space creates something in the open folder, pastes what
you cut, or changes the sort order. You see only what your role allows:
a viewer can open and copy links, nothing else.

## Keyboard shortcuts

::flow{id="explorer-keyboard-only" hide-title}
::

The list is one stop of the Tab key; inside it the keys below work. On a
Mac use Cmd instead of Ctrl.

| Key | What it does |
|---|---|
| Up / Down, Page Up / Page Down, Home / End | Move through the list (with Shift: extend the selection) |
| Ctrl + Up / Down, then Ctrl + Space | Move without selecting, then add or remove the item |
| Enter | Open the document or folder |
| Backspace or Alt + Up | Go up one folder |
| F2 | Rename |
| Delete | Delete (asks first) |
| Ctrl + A | Select everything in the folder |
| Ctrl + X, then Ctrl + V | Cut, then paste into the open folder (a move) |
| Ctrl + Z | Undo the last move |
| Alt + N (Option + N on a Mac) | New folder |
| Escape | Clear the selection |
| Typing a name | Jumps to the first item that starts with it |
| Ctrl + K | Search all your documents |

## On a phone

- Tap a document or folder to open it.
- Press and hold one to see its actions (rename, move, delete and the
  rest).
- Tap **Select** to tick several items, then use **Actions** in the bar
  at the bottom of the list, for example **Move to...**.
- The folder button next to the path opens the folder tree; the arrow
  goes up one folder.

## Delete a folder

::flow{id="delete-a-folder" hide-title}
::

Deleting a folder deletes **everything inside it**: its subfolders and all
their documents. Before anything is deleted, markoto counts what that is
and shows it. Deleted documents can't be restored.

You can delete a folder only if you may delete every document in it. In
a workspace, admins may delete any document and editors their own; when
some documents inside belong to other people, the confirmation says how
many and nothing is deleted. Move those documents out first, or ask an
admin.

## When several people work at once

::flow{id="explorer-two-people" hide-title}
::

- The list refreshes by itself within about 15 seconds when someone else
  adds, moves, renames or deletes something, and right away when you come
  back to the tab.
- If you act on something that someone else has just moved or deleted,
  markoto says so and refreshes the list. If the folder you are in was
  deleted, you are taken back to the top.
- Moving or renaming a document that someone has open doesn't interrupt
  them: they keep writing.
- If a document someone has open is deleted (by its owner, a workspace
  admin, or with the folder it was in), they see a note that it was
  deleted. Their text stays on screen but is no longer saved, so the editor
  stops taking changes. **Download Markdown**, in the note and in the bar
  above the text, saves a copy of it before they close the document.

## What's next

- [Import many files at once](/docs/import-export/bulk-import): folders, zip archives and GitHub.
- [Roles inside a workspace](/docs/workspaces/roles): who may create, move and delete.
- [Delete a document](/docs/writing/delete-document): one document, from inside the editor.
