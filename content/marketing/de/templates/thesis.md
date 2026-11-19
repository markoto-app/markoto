---
title: Abschlussarbeit Vorlage in Markdown mit PDF
description: Abschlussarbeit-Vorlage in Markdown mit Titelseite, Kurzfassung, Inhaltsverzeichnis, Kapitel pro Seite, nummerierten Tabellen, Fussnoten und Anhang als PDF.
keywords:
  - abschlussarbeit vorlage
  - bachelorarbeit vorlage markdown
  - masterarbeit vorlage
  - masterarbeit vorlage pdf
  - abschlussarbeit in markdown schreiben
updated: '2026-11-19'
# Menu label once reviewed (group + order come from the English page).
navLabel: "Abschlussarbeit-Vorlage"
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Abschlussarbeit Vorlage in Markdown

Eine Abschlussarbeit ist lang, hat eine feste Struktur und wird auf Papier oder als PDF gelesen. Diese Vorlage gibt dir die Struktur: Titelseite, Kurzfassung, Danksagung, Inhaltsverzeichnis, dann Kapitel von der Einleitung bis zum Fazit, ein Literaturverzeichnis und ein Anhang. Du schreibst Markdown; das Design **Thesis** setzt jedes Kapitel auf eine neue Seite unter „Kapitel 1“, „Kapitel 2“ und so weiter und nummeriert Tabellen und Abbildungen innerhalb ihres Kapitels.

Unten siehst du den Anfang einer kurzen Masterarbeit, die damit geschrieben ist. Bearbeite sie und sieh zu, wie sich die Seiten ändern.

::try-it{theme="thesis" height="760"}
---
source: |
  # Lesegeschwindigkeit auf Papier und am Bildschirm

  # Kurzfassung

  Wir haben Lesegeschwindigkeit und Erinnerung bei 120 Studierenden verglichen, die dieselben Texte auf Papier und auf einem Tablet lasen. Die Geschwindigkeit unterschied sich nicht, die Erinnerung an Details lag am Bildschirm aber um 9% tiefer.

  <!-- pagebreak -->

  [[toc]]

  # Einleitung

  ## Forschungsfragen

  1. Verändert das Medium, wie schnell Menschen lesen?
  2. Verändert es, woran sie sich erinnern?

  # Methode

  Jede teilnehmende Person las vier Texte, zwei pro Medium. Die Erinnerung ist der Anteil richtiger Antworten, und die Effektstärke geben wir an als

  $$
  d = \frac{\bar{x}_{\text{Papier}} - \bar{x}_{\text{Bildschirm}}}{s_{\text{gepoolt}}} \tag{1}
  $$

  # Ergebnisse

  Table: Lesegeschwindigkeit und Erinnerung nach Medium.

  | Mass | Papier | Bildschirm |
  |---|--:|--:|
  | Wörter pro Minute | 238 | 241 |
  | Erinnerung (%) | 71 | 62 |

  # Fazit

  Das Medium veränderte, woran sich die Lesenden erinnerten, nicht, wie schnell sie lasen.[^1]

  [^1]: Alle Texte waren Sachtexte; erzählende Texte verhalten sich möglicherweise anders.
---
::

::page-shots{caption="Die erste Seite der Abschlussarbeit-Vorlage: die Titelseite mit Untertitel, Autorin oder Autor und Hochschule aus den Feldern der Titelseite."}
---
pages:
  - src: /template-thumbs/thesis.webp
    alt: Titelseite der Abschlussarbeit-Vorlage mit Titel, Art der Arbeit, einem Autorennamen und einer Hochschule.
---
::

::cta{title="Starte deine Abschlussarbeit mit dieser Vorlage." label="Vorlage verwenden" template="thesis" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit der Abschlussarbeit-Vorlage: Text und Design Thesis in einem. Jeder Abschnitt beginnt mit einer kurzen Anleitung, was dort hineingehört.
::

## Was drin ist

- **Titelseite.** Titel, Art der Arbeit und Institut als Untertitel, dein Name, deine Hochschule und das Datum. Die Angaben trägst du im Dokumentdesign unter **Titelseite** ein.
- **Kurzfassung und Danksagung.** Die Anleitung zur Kurzfassung verlangt höchstens eine Seite, zuletzt geschrieben. Überschriften mit `{.unnumbered}` bleiben aus der Kapitelnummerierung heraus.
- **Inhaltsverzeichnis.** `[[toc]]` listet Kapitel und Abschnitte mit Seitenzahlen.
- **Kapitel.** Einleitung mit Forschungsfragen, Beiträgen und Aufbau; Hintergrund und verwandte Arbeiten; Methode; Ergebnisse; Diskussion mit Einschränkungen; Fazit. Jede Überschrift der obersten Ebene ist ein Kapitel und beginnt eine neue Seite.
- **Literaturverzeichnis und Anhang.** Einträge mit hängendem Einzug, danach das ergänzende Material nach dem Literaturverzeichnis.

Die Anleitungen unter den Überschriften sind Markdown-Kommentare: im Editor und für den KI-Assistenten sichtbar, nie auf der Seite oder im PDF.

## Was Markdown dir hier bietet

- **Nummerierte Tabellen und Abbildungen.** Eine Zeile `Table:` über einer Tabelle ist ihre Beschriftung; ein Bild allein in seinem Absatz bekommt seinen Alternativtext als Beschriftung. Die Nummern laufen innerhalb des Kapitels.
- **Gleichungen mit Nummern.** Abgesetzte Formeln in LaTeX-Syntax, mit `\tag{1}` für eine Nummer, auf die du dich beziehen kannst.
- **Fussnoten**, die am Fuss der Seite stehen, zu der sie gehören.
- **Definitionen und Abkürzungen.** Eine Definitionsliste für Begriffe und eine Zeile wie `*[ABC]: Voller Name`, um eine Abkürzung beim Darüberfahren zu erklären.
- **Diagramme.** Mermaid-Diagramme für Flussdiagramme und Zeitleisten.
- **Versionsverlauf.** Jede Änderung wird festgehalten. Du siehst, was sich geändert hat, und kannst einen früheren Stand wiederherstellen; im kostenlosen Plan von markoto.app reicht der Verlauf 30 Tage zurück, auf einer selbst betriebenen Instanz ohne Limit.

## Was es nicht kann

markoto hat kein BibTeX und keine Literaturverwaltung: Das Literaturverzeichnis tippst du von Hand, im Stil, den deine Hochschule verlangt. Eine hochschulspezifische Vorlage gibt es ebenfalls nicht, nur dieses allgemeine Layout für Abschlussarbeiten, das du im Design anpassen kannst (Schriften, Ränder, Kopfzeile, Fusszeile, Titelseite). Wenn deine Hochschule eine eigene LaTeX- oder Word-Klasse vorschreibt, nimm diese. Siehe [markoto im Vergleich zu Overleaf](/compare/overleaf).

## Für wen es ist

Für Studierende, die eine Bachelor- oder Masterarbeit schreiben, oder eine Dissertation, deren Hochschule ein PDF in freiem Layout akzeptiert. Deine Betreuungsperson kann dasselbe Dokument öffnen und eine Stelle kommentieren, und das PDF kannst du an die Gutachtenden schicken. Mehr zum Schreiben im Studium findest du unter [akademisches Schreiben](/de/academic-writing).

## Fragen

::faq{json-ld}
---
items:
  - q: Beginnt jedes Kapitel auf einer neuen Seite?
    a: Ja. Das Design Thesis beginnt jede Überschrift der obersten Ebene auf einer neuen Seite und beschriftet sie mit „Kapitel 1“, „Kapitel 2“ und so weiter. Überschriften mit {.unnumbered}, etwa die Kurzfassung und das Literaturverzeichnis, werden nicht nummeriert.
  - q: Kann ich das Literaturverzeichnis mit BibTeX schreiben?
    a: Nein. markoto hat weder BibTeX noch eine Literaturverwaltung. Du tippst die Einträge von Hand, je einen Absatz; das Design setzt einen hängenden Einzug.
  - q: Kann meine Betreuungsperson den Entwurf kommentieren?
    a: Ja. Wer Bearbeitungsrechte für das Dokument hat, kann eine Stelle kommentieren, antworten und Threads abschliessen. Teile den Link mit Bearbeitungsrechten oder lade die Person in einen Workspace ein.
  - q: Kann ich das Layout an die Vorgaben meines Instituts anpassen?
    a: Weitgehend. Schriften, Ränder, Kopfzeile, Fusszeile und Titelseite stellst du im Dokumentdesign ein, und eigenes CSS ist verfügbar, wo dein Plan es enthält. Die LaTeX-Klasse einer Hochschule lässt sich nicht nachbauen.
---
::

::cta{title="Eine Abschlussarbeit mit echten Seiten, in Markdown geschrieben." label="Vorlage verwenden" template="thesis"}
Kostenlos auf markoto.app, ohne Registrierung.
::
