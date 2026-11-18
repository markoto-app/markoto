---
title: Import many files at once
description: Bring in whole folders, zip archives or a public GitHub repository. Folders are kept, images come along, links between files keep working.
category: import-export
order: 2
updated: '2026-11-18'
---

# Import many files at once

Moving your notes over from another tool, or a folder of Word files from
a shared drive? Import them in one go, into **My documents** or into a
folder of a workspace. Every file becomes its own document, folders stay
folders.

::flow{id="import-a-folder-of-markdown" hide-title}
::

## What you can import

Open the folder the files should go into, then pick **New → Import
files...**, right-click a folder and pick **Import files...**, or simply
drop files or a folder from your computer onto the list.

- **Files:** Markdown (`.md`), Word (`.docx`), PDF, PowerPoint (`.pptx`),
  Excel (`.xlsx`, `.xls`), HTML and EPUB. Word, PDF and the other formats
  are converted to Markdown, the same way as
  [importing a single file](/docs/import-export/import-existing).
- **A folder:** **Choose a folder**, or drop it. Its subfolders become
  folders in markoto.
- **Zip archives:** each `.zip` becomes a folder named after it, with
  everything inside.
- **A GitHub link:** switch to **GitHub** and paste the link of a public
  repository, or of a folder in one (for example
  `https://github.com/owner/repository/tree/main/docs`). Its Markdown
  files and the images they use are imported.

Before anything is uploaded, the import window lists how many documents,
images and archives it found, and how many files it skips because markoto
can't read them.

## Images and links

- Images in Word and PowerPoint files come along into the document.
- Images that a Markdown file shows with a relative path
  (`![Diagram](images/flow.png)`) are imported with it, as long as they are
  part of the same import. PNG, JPEG, GIF and WebP work.
- A link from one imported Markdown file to another (`[setup](setup.md)`)
  points at the imported document afterwards.
- A document's title is its first heading, or the file name when it has
  none.

## Files saved from markoto, and other tools' settings

A Markdown file [saved from markoto](/docs/import-export/save-markdown)
comes back with its settings: title, description, audience, language,
template and the whole design, including custom CSS. Images the design
used (a cover logo, a header or footer picture) belong to the original
document and are not imported, so those fields start empty. In a workspace
whose design is locked, the document takes the workspace design instead.

Many tools put a settings block between two `---` lines at the top of a
file (Hugo, Docusaurus, Obsidian and others). markoto removes that block
from the text and keeps its `title` and `description`; everything else in
it is left out.

## While it runs

The import runs on markoto's side: you can close the window and keep
working, and the documents appear as they are imported. The window shows
how many are done. **Stop import** stops it; the documents imported so far
stay. At the end you see which files couldn't be imported, and why (too
large, not a supported type, couldn't be converted). You can run one
import at a time.

## Limits

How much one import may bring in depends on the plan. On markoto.app:

| Plan | Files per import | Size per import |
|---|---|---|
| Free | 200 | 200 MB |
| Pro | 1,000 | 1 GB |
| Team and Business | 5,000 | 5 GB |

Files count the documents and the images they bring along. A
self-hosted instance sets its own limits.

## Private repositories

Only public GitHub repositories can be imported from a link. For a
private one, download it as a zip on GitHub (**Code → Download ZIP**) and
import the zip.

## What's next

- [Organize documents in folders](/docs/workspaces/organize-documents): sort what you imported, find it again.
- [Bring an existing document in](/docs/import-export/import-existing): one file into the document you have open.
