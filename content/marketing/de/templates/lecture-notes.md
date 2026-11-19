---
title: Vorlesungsskript Vorlage in Markdown mit Formeln
description: Eine Vorlesungsskript-Vorlage in Markdown mit Lernzielen, Definitionen, Sätzen, Beispielen und Aufgaben als PDF-Handout. Formeln in LaTeX-Syntax.
keywords:
  - vorlesungsskript vorlage
  - skript vorlage markdown
  - vorlesungsskript markdown
  - mathe skript pdf
  - handout vorlage lehre
updated: '2026-11-19'
# Menu label once reviewed (group + order come from the English page).
navLabel: "Vorlesungsskript-Vorlage"
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Vorlesungsskript Vorlage in Markdown

Ein Vorlesungsskript wird zweimal gelesen: von den Studierenden während des Kurses und noch einmal vor der Prüfung. Es braucht Lernziele am Anfang, Definitionen, die man wiederfindet, durchgerechnete Beispiele und am Ende Aufgaben. Diese Vorlage hat alles davon, gesetzt im Design **Lecture notes** mit nummerierten Abschnitten und einem Titelblock mit Kurs, Dozentin oder Dozent und Datum.

Unten siehst du eine kurze Vorlesung, die damit geschrieben ist. Bearbeite das Markdown, und die Vorschau folgt.

::try-it{theme="lecture-notes" height="760"}
---
source: |
  # Vorlesung 3: Mittelwert und Varianz

  # Lernziele {.unnumbered}

  Nach dieser Vorlesung kannst du:

  - Mittelwert und Varianz eines Datensatzes berechnen;
  - erklären, warum die Varianz quadriert wird;
  - entscheiden, wann der Median die bessere Zusammenfassung ist.

  # Der Mittelwert

  Mittelwert
  : Der **Mittelwert** von $n$ Werten ist ihre Summe geteilt durch $n$.

  > [!TIP]
  > Anschauung: Der Mittelwert ist der Punkt, an dem ein Lineal mit Gewichten im Gleichgewicht ist.

  **Beispiel 3.1.** Die Werte 2, 4 und 9 haben den Mittelwert

  $$
  \bar{x} = \frac{2 + 4 + 9}{3} = 5.
  $$

  # Die Varianz

  > [!IMPORTANT]
  > **Satz 3.2.** Die Varianz ist der Mittelwert der quadrierten Abweichungen vom Mittelwert: $s^2 = \frac{1}{n}\sum_i (x_i - \bar{x})^2$.

  > [!WARNING]
  > Teilst du durch $n - 1$ statt durch $n$, erhältst du die Stichprobenvarianz. Prüfe, welche deine Formelsammlung verwendet.

  # Aufgaben

  1. Berechne die Varianz von 2, 4 und 9.
  2. Zwei Datensätze haben denselben Mittelwert. Können sich ihre Varianzen unterscheiden?
  3. ★ Zeige, dass das Addieren einer Konstanten zu jedem Wert die Varianz nicht verändert.
---
::

::page-shots{caption="Die erste Seite der Vorlesungsskript-Vorlage, mit dem Titelblock aus Kurs, Dozentin oder Dozent und Datum."}
---
pages:
  - src: /template-thumbs/lecture-notes.webp
    alt: Erste Seite der Vorlesungsskript-Vorlage mit Titelblock, Lernzielen und dem Beginn des ersten Themas.
---
::

::cta{title="Starte deine nächste Vorlesung mit dieser Vorlage." label="Vorlage verwenden" template="lecture-notes" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit der Vorlesungsskript-Vorlage: Text und Design Lecture notes in einem.
::

## Was drin ist

- **Titelblock.** Kurs und Semester als Untertitel, der Titel der Vorlesung, die Dozentin oder der Dozent und das Datum.
- **Lernziele.** Drei bis fünf Ziele, jedes mit einem Verb, an dem sich Studierende selbst prüfen können.
- **Themen mit Definitionen.** Eine Definitionsliste für Begriffe, ein Tipp-Kasten für die Anschauung und ein durchgerechnetes Beispiel, nach Vorlesung nummeriert (3.1, 3.2), damit Studierende es zitieren können.
- **Das Hauptergebnis.** Ein Satz in einem Hinweiskasten, ein Beweis, eine Bemerkung dazu, wann er gilt, und eine Warnung vor dem häufigen Fehler.
- **Zusammenfassung und Aufgaben.** Aufgaben von Routine bis schwer (schwere mit einem Stern markieren), mit Teilen (a), (b), (c) als verschachtelte Liste, danach weiterführende Literatur.

Die grauen Notizen unter jeder Überschrift sind Markdown-Kommentare: Sie zeigen sich im Editor und für den KI-Assistenten, nie im PDF.

## Was Markdown dir hier bietet

- **Formeln in LaTeX-Syntax**, im Text mit `$...$` und abgesetzt mit `$$...$$`, in Vorschau und PDF mit KaTeX gesetzt.
- **Hinweiskästen** (`> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!NOTE]`) für Anschauung, Sätze und Stolperfallen.
- **Diagramme** mit Mermaid und Codeblöcke mit Syntaxhervorhebung für Programmierkurse.
- **Nummerierte Abschnitte** aus dem Design, du tippst also nie Nummern, die veralten, wenn du einen Abschnitt verschiebst.

## Jede Woche wiederverwenden

Dupliziere die Vorlesung der letzten Woche (**Datei › Duplizieren…**, mit Konto), um Titelblock und Struktur zu behalten. Studierende können den Link nur lesend öffnen, oder du veröffentlichst das Skript als Webseite: ein Schnappschuss unter eigener Adresse, den alle ohne Konto lesen können. Veröffentlichen ist in jedem Plan enthalten.

## Was es nicht kann

Die Aufgaben sind Text: markoto hat keine Quiz- oder Antwortprüfung und keinen Folienmodus. Was markoto sonst für den Unterricht bietet, steht unter [markoto für Lehrpersonen](/de/for-teachers).

## Fragen

::faq{json-ld}
---
items:
  - q: Kann ich Formeln im Skript schreiben?
    a: Ja. Formeln im Text und abgesetzte Formeln in LaTeX-Syntax werden in der Vorschau und im PDF mit KaTeX gesetzt.
  - q: Können Studierende das Skript ohne Konto lesen?
    a: Ja. Teile das Dokument nur lesend oder veröffentliche es als Webseite. Wer die Adresse hat, liest es ohne Registrierung.
  - q: Kann ich Sätze und Beispiele automatisch nummerieren?
    a: Die Abschnittsnummern kommen aus dem Design. Definitionen, Sätze und Beispiele nummerierst du von Hand (3.1, 3.2) in einer fetten Einleitung, damit man sie zitieren kann.
  - q: Kann ich das Skript als Handout drucken?
    a: Ja. Lade das PDF über Datei › Exportieren › PDF herunter. Es hat dieselben Seiten wie die Vorschau.
---
::

::cta{title="Ein Vorlesungsskript, das gedruckt wie ein Skript aussieht." label="Vorlage verwenden" template="lecture-notes"}
Kostenlos auf markoto.app, ohne Registrierung.
::
