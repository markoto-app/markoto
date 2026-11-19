---
title: "Wissenschaftlich schreiben in Markdown"
description: Abschlussarbeit, Paper und Skript in Markdown schreiben, mit LaTeX-Formeln, Diagrammen und Fussnoten. Mitautoren kommentieren live, das PDF hat echte Seiten.
keywords:
  - wissenschaftlich schreiben markdown
  - abschlussarbeit schreiben
  - masterarbeit in markdown schreiben
  - formeln markdown pdf
  - gemeinsam wissenschaftlich schreiben
# Menu label once reviewed (group + order come from the English page).
navLabel: "Wissenschaftlich schreiben"
updated: '2026-11-19'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Wissenschaftlich schreiben in Markdown

Studierende, Forschende und Dozierende schreiben immer wieder dieselben Dokumente: eine Abschlussarbeit, ein Paper, ein Essay, ein Skript. markoto ist für Leute, die lieber Markdown schreiben, als LaTeX zu lernen, und trotzdem Formeln, nummerierte Tabellen, Fussnoten und ein PDF mit echten Seiten brauchen. Mitautorinnen, Mitautoren und Betreuende arbeiten im selben Dokument, und du siehst ihre Kommentare neben den Sätzen, die sie meinen.

::tour-clip{scene="collab"}
::

## Wähle das Dokument, das du schreibst

::template-cards
---
items:
  - to: /de/templates/thesis
    title: Abschlussarbeit
    image: /template-thumbs/thesis.webp
    text: Titelseite, Abstract, Inhaltsverzeichnis, ein Kapitel pro Seite, nummerierte Tabellen und Abbildungen, Literaturverzeichnis und Anhang.
    link: Die Vorlage Abschlussarbeit
  - to: /templates/academic-paper
    title: Paper (arXiv-Preprint)
    image: /template-thumbs/arxiv.webp
    text: Vom Abstract bis zu den Referenzen, gesetzt wie ein arXiv-Preprint mit Titelblock, nummerierten Abschnitten und LaTeX-Formeln.
    link: Die Vorlage Paper
  - to: /de/templates/lecture-notes
    title: Vorlesungsskript
    image: /template-thumbs/lecture-notes.webp
    text: Lernziele, Definitionen, Sätze, durchgerechnete Beispiele und Übungen mit Teilaufgaben.
    link: Die Vorlage Vorlesungsskript
  - to: /de/templates/essay
    title: APA-Essay
    image: /template-thumbs/essay.webp
    text: Eine APA-7-Titelseite, These, Hauptpunkte, Gegenargumente und ein doppelzeiliges Literaturverzeichnis.
    link: Die Vorlage APA-Essay
---
::

Im Dialog für neue Dokumente gibt es ausserdem ein **IEEE-Konferenzpapier** in zwei Spalten. Jede Vorlage gibt es auf Englisch und Deutsch.

## Formeln, Diagramme und Tabellen

- **Formeln in LaTeX-Syntax.** Im Text `$...$` und abgesetzt `$$...$$`, mit KaTeX dargestellt, auf der Seite und im PDF. Eine Gleichung, auf die du dich beziehst, nummerierst du mit `\tag{1}`.
- **Diagramme.** Mermaid zeichnet Flussdiagramme, Sequenz-, Klassen-, Zustands- und ER-Diagramme, Gantt-Diagramme, Mindmaps und Zeitleisten aus ein paar Zeilen Text, in den Farben des Themes. Siehe [Diagramme und Formeln](/markdown-mermaid-math) (auf Englisch).
- **Tabellen und Abbildungen mit Beschriftung.** Eine Zeile `Table:` über einer Tabelle ist ihre Beschriftung. Im Thesis-Theme werden Tabellen und Abbildungen innerhalb ihres Kapitels nummeriert.
- **Fussnoten**, die am Fuss der Seite stehen, zu der sie gehören.
- **Code** mit Syntaxhervorhebung, für rechnergestützte Arbeiten.
- **Definitionslisten und Abkürzungen** für Begriffe, die du einmal definierst und durchgehend verwendest.

## Seiten, keine Webseite

Die Vorschau zeigt beim Schreiben A4- oder Letter-Seiten, und das PDF hat genau diese Seiten. Ein Theme legt Schriften, Ränder, Spalten, Kopf- und Fusszeile fest. Eingebaut sind ein arXiv-Preprint-Look (Times, Blocksatz, nummerierte Abschnitte, Titelblock), ein zweispaltiger IEEE-Look, ein Abschlussarbeit-Look mit Titelseite und einer Seite pro Kapitel und ein Skript-Look. Ändere jedes Detail und speichere es als eigene Vorlage.

::flow-strip{id="pick-a-theme" frames="05"}
---
captions:
  - Das Theme arXiv-Preprint: Blocksatz in Times, nummerierte Abschnitte und der Titel in einem Block oben auf Seite 1.
---
::

## Mit Mitautorinnen und Betreuenden schreiben

- **Mehrere Personen gleichzeitig**, mit eigenen Cursorn, im selben Dokument.
- **Kommentare an einem Satz.** Markiere eine Stelle, kommentiere, antworte und schliesse den Thread. Der Kommentar bleibt an seiner Stelle, wenn sich der Text ändert.
- **Verlauf jeder Änderung.** Sieh, wer was geändert hat, und stelle einen früheren Stand wieder her. Im kostenlosen Tarif von markoto.app reicht der Verlauf 30 Tage zurück; auf einer selbst gehosteten Instanz ist er nicht begrenzt.
- **Einen Link teilen** für Zugriff nur zum Lesen, bei Bedarf mit Passwort, oder Leute in einen Workspace einladen. Wer Bearbeitungsrechte hat, kann kommentieren; ein Nur-Lesen-Link kann lesen, aber nicht kommentieren.

::flow-strip{id="two-writers-one-document" frames="07"}
---
captions:
  - Der Absatz einer Mitautorin erscheint im Dokument, während du arbeitest.
---
::

## KI dort, wo sie hilft, und dort, wo nicht

Die Eingabeleiste bearbeitet deinen Text, wenn du sie darum bittest. Markiere einen Absatz und bitte darum, ihn kürzer oder klarer zu machen; erwähne `@markoto` in einem Kommentar, um nach einer Stelle zu fragen; übersetze ein Abstract oder ein Kapitel in eine andere Sprache, zuerst mit einer Schätzung und mit einem Auftrag, der sich ganz rückgängig machen lässt. Lade die Paper und Notizen, mit denen du arbeitest, in den Tab **Wissen** eines Workspace hoch und stelle Fragen dazu: Die KI durchsucht deine Dateien und antwortet aus dem, was sie findet. Jede KI-Änderung wird festgehalten, und du kannst markoto ganz ohne KI nutzen. Prüfe alles, was die KI schreibt, bevor es in deine Arbeit einfliesst.

## Was es nicht kann

- **Kein BibTeX und keine Literaturverwaltung.** Das Literaturverzeichnis tippst du von Hand, in dem Stil, den dein Institut oder deine Zeitschrift verlangt.
- **Keine Zeitschriften- oder Universitätsvorlagen**, ausser den Layouts arXiv-Preprint, IEEE-Konferenz und Abschlussarbeit. Verlangt dein Verlag eine eigene LaTeX- oder Word-Vorlage, nutze diese.
- **Kein LaTeX jenseits von Formeln.** Wenn du Pakete, Makros oder feine Satzkontrolle brauchst, sind [Overleaf](/compare/overleaf) oder [Typst](/compare/typst) (auf Englisch) die besseren Werkzeuge.

## In der EU gehostet, betrieben von einer Schweizer Firma

markoto.app speichert Dokumente in Frankreich, nutzt für die KI Anbieter aus der EU und wird von einer Schweizer Firma betrieben. Entwürfe sind privat, bis du sie teilst. Siehe die Seite [EU-Hosting](/de/eu-markdown-editor), oder betreibe markoto auf deinem eigenen Server.

## Fragen

::faq{json-ld}
---
items:
  - q: Kann ich eine Abschlussarbeit in Markdown schreiben?
    a: Ja. Die Vorlage Abschlussarbeit setzt eine Titelseite, ein Abstract, ein Inhaltsverzeichnis, ein Kapitel pro Seite, nummerierte Tabellen und Abbildungen, Fussnoten und einen Anhang. Das Literaturverzeichnis tippst du von Hand, weil markoto kein BibTeX hat.
  - q: Unterstützt markoto LaTeX-Formeln?
    a: Ja, innerhalb von Markdown. Formeln im Text und abgesetzt in LaTeX-Syntax werden mit KaTeX in der Vorschau und im PDF dargestellt.
  - q: Kann ich ein Paper mit Mitautorinnen und Mitautoren schreiben?
    a: Ja. Mitautorinnen und Mitautoren bearbeiten dasselbe Dokument live und kommentieren einzelne Stellen. Jede Änderung wird festgehalten und lässt sich wiederherstellen.
  - q: Kann ich das PDF bei einer Zeitschrift einreichen?
    a: Wenn die Zeitschrift ein PDF in beliebigem Layout akzeptiert, ja. Verlangt sie ihre eigene LaTeX- oder Word-Vorlage, brauchst du diese Vorlage.
  - q: Kann ich Paper hochladen und Fragen dazu stellen?
    a: Ja, in einem Workspace. Lade PDFs und andere Dateien in den Tab Wissen, und die KI antwortet daraus, wenn du fragst. Der kostenlose Tarif auf markoto.app erlaubt ein paar Dateien.
  - q: Ersetzt es Overleaf?
    a: Für Dokumente, die keine LaTeX-Pakete, Zeitschriftenvorlagen oder Literaturverwaltung brauchen, ja. Sonst nimm ein LaTeX-Werkzeug; die Vergleichsseiten sagen, wo welches besser ist.
---
::

::cta{title="Schreib das Paper. Hol dir die Seiten." secondary-label="Alle Vorlagen" secondary-to="/templates"}
Auf markoto.app kostenlos, zum Start ist keine Registrierung nötig.
::
