---
title: Markdown-Spickzettel
description: Markdown-Syntax auf einer Seite, jedes Beispiel neben seinem Ergebnis. Entwurf, noch nicht geprüft.
updated: '2026-11-04'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Remove once reviewed.
reviewed: false
---

# Markdown-Spickzettel

Die wichtigste Markdown-Syntax, jeweils der Quelltext neben seinem Ergebnis. Diese Seite ist ein Entwurf; die vollständige Fassung gibt es vorerst auf [Englisch](/markdown-cheat-sheet).

## Überschriften

Ein `#` pro Ebene, von `#` (Titel) bis `######`. Nach den Rauten folgt ein Leerzeichen.

::sample{kind="commonmark"}
---
source: |
  # Titel
  ## Abschnitt
  ### Unterabschnitt
---
::

## Fett, kursiv und durchgestrichen

::sample{kind="commonmark"}
---
source: |
  **Fett**, *kursiv* und ***beides***.
---
::

::sample{kind="gfm"}
---
source: |
  ~~Durchgestrichen~~
---
::

## Tabellen

::sample{kind="gfm"}
---
source: |
  | Artikel | Menge | Preis |
  |:--------|:-----:|------:|
  | Papier  |   2   |  4.50 |
  | Stifte  |  12   |  9.00 |
---
::
