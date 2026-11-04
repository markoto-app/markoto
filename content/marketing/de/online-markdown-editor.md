---
title: Markdown-Editor online mit Seitenvorschau
description: Markdown im Browser schreiben und beim Tippen als Druckseiten sehen. Ohne Registrierung. Link teilen, gemeinsam bearbeiten, als .md oder PDF herunterladen.
keywords:
  - markdown editor online
  - online markdown editor
  - markdown editor kostenlos
  - markdown editor mit vorschau
  - markdown live vorschau
# Menu label once reviewed (group + order come from the English page).
navLabel: "Markdown-Editor online"
updated: '2026-11-04'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). See docs/TRANSLATION-REVIEW.md.
reviewed: false
---

# Ein Markdown-Editor online, mit Seitenvorschau

Sie tippen Markdown, und die Vorschau daneben zeigt den Text als Seiten, so wie sie gedruckt werden. Der Editor läuft im Browser und braucht kein Konto. Probieren Sie es hier aus:

::try-it{theme="modern"}
---
source: |
  # Sitzungsprotokoll

  **Datum:** 4. November · **Mit:** Maya, Sam

  ## Beschlüsse

  1. Die Beta erscheint am ==Montag==.
  2. Der alte Export bleibt noch eine Version lang.

  ## Aufgaben

  - [ ] Maya: Release Notes schreiben
  - [ ] Sam: PDF auf Letter-Papier prüfen
  - [x] Raum reservieren

  | Thema   | Zuständig | Fällig |
  |:--------|:----------|:-------|
  | Beta    | Maya      | Mo     |
  | Preise  | Sam       | Fr     |
---
::

Möchten Sie den Text behalten, macht **Als Dokument öffnen** daraus ein richtiges Dokument mit eigenem Link. Der volle Editor bietet zusätzlich eine Formatierungsleiste, Menüs, Themes, Kommentare und einen Verlauf.

## Was ohne Konto geht

Auf markoto.app können Sie sofort losschreiben. Ohne Konto können Sie:

- Dokumente erstellen und mit dem vollen Editor bearbeiten,
- den Link teilen: Alle, die ihn haben, können live mitlesen und mitschreiben,
- Dateien importieren und Markdown oder ein PDF herunterladen.

Ein ohne Konto erstelltes Dokument wird nach 30 Tagen ohne Änderung gelöscht. Beim ersten Mal bittet markoto Sie, die Nutzungsbedingungen zu akzeptieren, und führt in Ihrem Browser eine kurze Bot-Prüfung durch.

Ein kostenloses Konto bringt Dokumente, die Ihnen gehören und privat bleiben, bis Sie sie teilen, dazu Links nur zum Lesen oder mit Passwort, Workspaces für ein Team, Bild-Uploads und den KI-Assistenten. Die Limits stehen auf der [Preisseite](/pricing).

## Die Vorschau zeigt Seiten

Die meisten Markdown-Editoren im Browser zeigen eine einzige lange Webseite. markoto zeigt A4- oder Letter-Seiten mit Rändern, Kopf- und Fusszeilen und Seitenzahlen. So sehen Sie vor dem Drucken, wo eine Tabelle umbricht oder eine Überschrift landet. Das PDF verwendet dasselbe Layout.

::tour-clip{scene="write"}
::

## Mehr als einfaches Markdown

Neben CommonMark und GitHub Markdown (Tabellen, Aufgabenlisten, Fussnoten, Hinweisboxen) stellt der Editor LaTeX-Formeln, Mermaid-Diagramme, Code mit Syntaxhervorhebung, ein Inhaltsverzeichnis und Seitenumbrüche dar. Wer die Syntax nicht im Kopf hat, fügt alles über das Menü **Einfügen** ein. Der [Markdown-Spickzettel](/de/markdown-cheat-sheet) zeigt jedes Beispiel neben seinem Ergebnis.

::flow-strip{id="rich-content" frames="20" caption="Ein Codeblock, ein Hinweis, eine Formel und ein Mermaid-Diagramm, beim Tippen dargestellt."}
::

## Einen Link teilen

Jedes Dokument hat seinen eigenen Link. Kopieren Sie ihn im Teilen-Dialog und verschicken Sie ihn; wer ihn öffnet, sieht Ihre Änderungen, während Sie tippen. Eigentümerinnen und Eigentümer können den Link auf «nur lesen» stellen oder mit einem Passwort schützen, und der Dialog zeigt den Link auch als QR-Code. Details in der [Dokumentation zum Teilen](/docs/sharing) (auf Englisch).

::flow-strip{id="quick-share" frames="13" caption="Der Teilen-Dialog: oben der Link zum Dokument, darunter der Zugriffsmodus."}
::

## Ihr Text bleibt Markdown

Das Dokument ist reines Markdown, und **Datei › Exportieren › Markdown** lädt es als `.md`-Datei herunter. Theme und Dokumenteinstellungen stehen in einem kurzen Frontmatter-Block am Anfang, den andere Programme ignorieren und markoto beim Import wieder einliest. **Datei › Importieren** öffnet `.md`-Dateien und wandelt Word-, PDF-, PowerPoint-, Excel-, HTML- und EPUB-Dateien in Markdown um.

## Grenzen

- **Kein Offline-Modus.** Um ein Dokument zu öffnen, braucht der Editor eine Verbindung. Bricht sie beim Tippen kurz ab, ist das kein Problem: Ihre Änderungen werden synchronisiert, sobald Sie wieder online sind.
- **Sie bearbeiten den Quelltext.** Links steht Markdown-Text mit einer Werkzeugleiste, keine Textverarbeitungsansicht. Die Vorschau lässt sich nicht bearbeiten.
- **Kein Änderungsmodus.** Alle mit Bearbeitungsrecht ändern den Text direkt. Jede Änderung bleibt im Verlauf mit Diff erhalten und lässt sich wiederherstellen.
- **Keine Desktop-App.** markoto läuft im Browser, auf dem Computer oder auf dem Handy.

Sie vergleichen Editoren? Sehen Sie markoto neben [HackMD](/compare/hackmd) und [HedgeDoc](/compare/hedgedoc) (auf Englisch).

## Fragen

::faq{json-ld}
---
items:
  - q: Ist der Markdown-Editor online kostenlos?
    a: Ja. Schreiben, Teilen und Exportieren sind auf markoto.app kostenlos, mit oder ohne Konto.
  - q: Muss ich mich registrieren?
    a: Nein. Sie können Dokumente ohne Konto erstellen und teilen. Sie werden nach 30 Tagen ohne Änderung gelöscht. Mit einem kostenlosen Konto bleiben Ihre Dokumente erhalten und privat, bis Sie sie teilen.
  - q: Wird mein Text gespeichert?
    a: Das Beispiel auf dieser Seite wird nicht gespeichert. Ein Dokument wird beim Tippen auf dem Server gespeichert, und jede Änderung bleibt in seinem Verlauf.
  - q: Können mehrere Personen gleichzeitig bearbeiten?
    a: Ja. Alle, die den Link öffnen, sehen die Cursor und Änderungen der anderen live, auch ohne Konto.
  - q: Kann ich mein Dokument herunterladen?
    a: Ja, als Markdown-Datei oder als PDF, über das Menü Datei.
  - q: Funktioniert es auf dem Handy?
    a: Ja. Auf dem Handy wechselt der Editor zwischen Schreiben und Seitenvorschau.
---
::

::cta{title="Schreiben Sie direkt im Browser." secondary-label="Dokumentation lesen" secondary-to="/docs/getting-started/quick-share"}
Ein neues Dokument ist in wenigen Sekunden offen. Ohne Registrierung.
::
