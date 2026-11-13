---
title: Markdown in PDF umwandeln, mit echten Seiten
description: Markdown einfügen, als A4- oder Letter-Seiten sehen und als PDF herunterladen. Mit Kopf- und Fusszeilen, Seitenzahlen, Deckblatt und Inhaltsverzeichnis.
keywords:
  - markdown in pdf umwandeln
  - markdown zu pdf
  - md in pdf konvertieren
  - markdown pdf online
  - markdown pdf mit seitenzahlen
  - markdown pdf mit inhaltsverzeichnis
# Menu label once reviewed (group + order come from the English page).
navLabel: "Markdown in PDF"
updated: '2026-11-08'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Markdown in PDF umwandeln, mit echten Seiten

Füge dein Markdown in das Feld unten ein. Die Vorschau setzt den Text schon beim Tippen als Druckseiten, mit laufender Kopfzeile und Seitenzahlen. Sieht alles richtig aus, klicke auf **PDF herunterladen**: Die Datei hat genau die Seiten der Vorschau.

::try-it{theme="modern" height="600"}
---
source: |
  # Projektbericht

  [[toc]]

  ## Zusammenfassung

  Füge hier dein eigenes Markdown ein. Die Vorschau zeigt es als A4-Seiten, und **PDF herunterladen** liefert dieselben Seiten als Datei.

  ## Ergebnisse

  | Quartal | Bestellungen | Veränderung |
  |:--------|-------------:|------------:|
  | Q1      |        1240 |           – |
  | Q2      |        1610 |        +30% |

  Die Wachstumsrate ist $g = \frac{1610 - 1240}{1240} \approx 0.30$.[^1]

  > [!NOTE]
  > Die Kopfzeile zeigt den Titel, die Fusszeile Seite *n* von *gesamt*.

  <!-- pagebreak -->

  ## Nächste Schritte

  - [x] Entwurf schreiben
  - [ ] Theme wählen
  - [ ] PDF verschicken

  [^1]: Fussnoten stehen unten auf der Seite, zu der sie gehören.
---
::

Das PDF wird auf unserem Server aus einem gespeicherten Dokument erzeugt. Deshalb speichert **PDF herunterladen** deinen Text zuerst als Dokument. Solange du nur im Feld tippst, wird nichts gespeichert.

## Was das PDF enthält

Ein Konverter macht aus Markdown eine einzige lange HTML-Seite und druckt sie. markoto setzt den Text zuerst als Seiten. So siehst und bestimmst du, wo was landet:

- **Seitenformat und Ränder.** A4, Letter oder Legal, hoch oder quer, mit den Rändern, die du festlegst.
- **Kopf- und Fusszeilen.** Felder links, in der Mitte und rechts für Dokumenttitel, Seitenzahl, Seitenanzahl und Datum, dazu auf Wunsch ein Logo.
- **Ein Deckblatt.** Vier Layouts mit Titel, Untertitel, Autorinnen und Autoren, Datum und Logo. Auf dem Deckblatt fallen Kopfzeile und Seitenzahl weg.
- **Ein Inhaltsverzeichnis mit Seitenzahlen.** Schreibe `[[toc]]` an die Stelle, wo es stehen soll.
- **Fussnoten unten auf der Seite**, nicht gesammelt am Schluss.
- **Seitenumbrüche** dort, wo `<!-- pagebreak -->` auf einer eigenen Zeile steht.
- **Formeln, Diagramme und Code.** LaTeX-Formeln (KaTeX), Mermaid-Diagramme, Code mit Syntaxhervorhebung, Tabellen und Hinweisboxen im GitHub-Stil erscheinen auf der Seite.

::flow-strip{id="polished-pdf" frames="07" caption="Ein heruntergeladenes PDF: das Deckblatt und die erste Inhaltsseite, so wie sie in der Vorschau aussahen."}
::

## Das Aussehen ändern, ohne den Text anzufassen

Jedes Dokument hat ein Theme: Schriften, Farben, Ränder, Spalten, Tabellen, Kopfzeile, Fusszeile und Deckblatt. Eingebaut sind unter anderem die Vorlagen markoto, Modern, arXiv-Preprint, IEEE-Konferenzbeitrag (zweispaltig), Abschlussarbeit, Technische Dokumentation, Unternehmensbericht, Newsletter und Lebenslauf. Wähle eine aus und passe danach jedes Detail an. Vorschau und PDF verwenden dasselbe Theme. Reicht keine Einstellung, kannst du einem Dokument eigenes [CSS](/docs/themes/custom-css) hinzufügen.

::flow-strip{id="pick-a-theme" frames="05,14"}
---
captions:
  - Die Vorlage «arXiv-Preprint» setzt den Text in Times im Blocksatz, nummeriert die Abschnitte und stellt den Titel in einem Block oben auf Seite 1.
  - Die Vorlage markoto mit ihrem Deckblatt, das Logo, Titel und Datum zeigt, aber keine Seitenzahl.
---
::

Mehr dazu in der Dokumentation (auf Englisch): [Theme wählen](/docs/themes/pick-a-theme), [Deckblatt bearbeiten](/docs/themes/cover-page), [Schriften, Farben und Seitenlayout](/docs/themes/customize).

## Du hast schon eine .md-Datei?

Erstelle ein Dokument, wähle **Datei › Importieren** und dann die Datei. Markdown-Dateien bis 10 MB werden unverändert geladen. Word- (.docx), PDF-, PowerPoint-, Excel-, HTML- und EPUB-Dateien bis 50 MB werden zuerst in Markdown umgewandelt. Danach exportierst du mit **Datei › Exportieren › PDF**.

::flow-strip{id="import-existing-document" frames="11" caption="Eine importierte Datei im Editor, daneben die Seitenvorschau."}
::

## Grenzen

- **Das PDF entsteht auf dem Server.** Ein neues PDF dauert ein paar Sekunden; fordere es ohne Änderungen erneut an, kommt es sofort. Aus einem Netzwerk lassen sich bis zu 10 PDFs pro Minute exportieren. Mit `Cmd/Ctrl + P` druckst du dieselben Seiten stattdessen über deinen Browser.
- **Rohes HTML wird nicht dargestellt.** HTML-Tags im Markdown erscheinen als Text. Verwende stattdessen Markdown-Syntax oder das Theme.
- **Drei Seitenformate.** A4, Letter und Legal. Eigene Seitenformate gibt es nicht.
- **Bilder brauchen ein Konto.** Ohne Konto kannst du keine Bilder in ein Dokument hochladen.
- **Ein Dokument nach dem anderen.** Die Seite hat keinen Stapelkonverter. Um viele Dokumente per Skript zu exportieren, nutze mit einem Konto den [MCP-Server](/docs/account/mcp).

Für wissenschaftliche Arbeiten: So schneidet markoto im Vergleich mit [Overleaf](/compare/overleaf) ab (auf Englisch). Preise und Limits stehen auf der [Preisseite](/pricing).

## Fragen

::faq{json-ld}
---
items:
  - q: Ist die Umwandlung von Markdown in PDF kostenlos?
    a: Ja. Auf markoto.app schreibst du, siehst die Vorschau und lädst PDFs herunter, ohne Konto und ohne zu bezahlen.
  - q: Muss ich mich registrieren?
    a: Nein. Ohne Konto entsteht das PDF aus einem anonymen Dokument, das alle mit dem Link bearbeiten können und das nach 30 Tagen ohne Änderung gelöscht wird. Mit einem kostenlosen Konto gehört das Dokument dir und bleibt privat.
  - q: Kann das PDF Seitenzahlen und ein Inhaltsverzeichnis haben?
    a: Ja. Fuss- oder Kopfzeile können die Seitenzahl und die Seitenanzahl zeigen, und das mit [[toc]] geschriebene Inhaltsverzeichnis nennt zu jeder Überschrift die Seite.
  - q: Sieht das PDF aus wie die Vorschau?
    a: Ja. Vorschau und PDF entstehen aus demselben Seitenlayout und demselben Theme, deshalb brechen die Seiten an denselben Stellen um.
  - q: Welches Markdown wird unterstützt?
    a: CommonMark und GitHub Markdown (Tabellen, Aufgabenlisten, Durchstreichen, Fussnoten, Hinweisboxen), dazu LaTeX-Formeln, Mermaid-Diagramme und einige Erweiterungen wie Hervorhebungen und Definitionslisten. Der Markdown-Spickzettel listet sie auf.
  - q: Kann ich statt A4 das Format Letter verwenden?
    a: Ja. Das Seitenformat legt jedes Theme fest; zur Wahl stehen A4, Letter und Legal, jeweils hoch oder quer.
---
::

::cta{title="Mache aus deinem Markdown ein PDF." secondary-label="PDF-Anleitung lesen" secondary-to="/docs/import-export/polished-pdf"}
Dokument anlegen, Text einfügen und das PDF herunterladen, sobald die Seiten stimmen. Ohne Registrierung.
::
