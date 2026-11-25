---
title: Brand kit of a workspace
description: Upload your organisation's fonts and logos, lock the workspace design for every document, and give members templates to start from.
category: workspace-admin
order: 1
updated: '2026-11-25'
---

# Brand kit of a workspace

> **Availability.** On markoto.app the brand kit is part of the **Team** and
> **Business** plans. On a self-hosted instance every workspace
> has it.

Workspace admins find the **Brand kit** tab on the workspace page. It holds
what makes documents look like your organisation's: fonts, logos, the
workspace design, and templates.

::flow{id="set-up-a-workspace-brand-kit" hide-title}
::

## Fonts

Upload one file per weight and style, for example *Acme Sans* Regular, Bold
and Italic, each under the same name. WOFF2, WOFF and TTF files are accepted.
Confirm that your licence allows embedding the font in documents: it is part
of every PDF made from them.

The fonts then appear under **This workspace** in the font pickers of every
document in the workspace, in the preview and in the PDF.

Some fonts are refused, with the reason:

- **Variable fonts** and fonts with **PostScript (CFF) outlines** print badly
  in PDFs (larger files, no hinting). Most foundries offer static TrueType
  files as well: upload those.
- Fonts whose licence flags forbid embedding, font collections (several fonts
  in one file), and damaged files.

## Logos

Upload PNG, JPEG or WebP images. Every document in the workspace can use them
as its cover logo or header image: they appear under **Workspace logos** in
the theme panel.

## Workspace design

The workspace design is the design new documents in the workspace start
with. Set it from one of your documents: design one document the way you
want it, then choose it under **Workspace design** and click **Use this
document's design**, or choose a ready-made design in the workspace's
Settings tab. Images uploaded to a single document are left out of the
workspace design; use the workspace logos instead.

**Lock the design for all documents** to use it everywhere: every document in
the workspace then looks the same, in the preview and in the PDF. Authors
still fill in their cover text (subtitle, date, authors and affiliations)
in the theme panel. Unlocking gives each document its own design back;
nothing is lost.

## Templates

Turn any workspace document into a template: choose it under **Templates**,
give it a name and add it. Members then find it in the **This workspace** tab
of the new-document dialog. A new document made from a template is a copy of
the template document as it is *now* (its text, design and images) so
improving the document improves the template. The copy starts private and
belongs to whoever made it.

A template goes away when its document is deleted or moved to another
workspace.

## What's next

- [Team and Business for a workspace](/docs/plans/team-plan).
- [Audit log of a workspace](/docs/workspace-admin/audit-log): font, logo, lock and
  template changes are recorded there.
