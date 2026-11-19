---
title: Newsletter Vorlage in Markdown mit PDF
description: Newsletter-Vorlage in Markdown mit Titelkopf, zwei Spalten, Aufmacher, Zitat, Terminetabelle und Kurzmeldungen, als PDF für Vereine und Schulen.
keywords:
  - newsletter vorlage pdf
  - vereinszeitung vorlage
  - newsletter vorlage markdown
  - schulzeitung vorlage
  - newsletter zum ausdrucken
updated: '2026-11-19'
# Menu label once reviewed (group + order come from the English page).
navLabel: "Newsletter-Vorlage"
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Newsletter Vorlage in Markdown

Ein Newsletter für einen Verein, eine Schule oder ein Quartier wird oft gedruckt oder als PDF verschickt. Diese Vorlage setzt eine Ausgabe wie eine kleine Zeitung: ein Titelkopf mit dem Namen des Newsletters, eine Ausgabenzeile, ein Aufmacher mit Zitat, eine Terminetabelle und eine Liste kurzer Meldungen, in zwei Spalten.

Unten siehst du eine Ausgabe, geschrieben mit dem Design **Newsletter**. Bearbeite den Text, und die Spalten laufen neu um.

::try-it{theme="newsletter" height="760"}
---
source: |
  # Der Lindenhof-Bote

  **Ausgabe 4 · November 2026 · Herausgegeben vom Dorfverein Lindenhof**

  ---

  # Die Bäckerei öffnet im März

  Nach zwei Jahren ohne Bäcker hat Lindenhof bald wieder Brot. Die Genossenschaft hat letzte Woche ihr Ziel von 400 Anteilscheinen erreicht, und der Mietvertrag für die alte Molkerei wurde am Montag unterschrieben.

  > «Wir backen sechs Tage die Woche.»

  Mitglied werden kann man noch bis Jahresende. Ein Anteilschein kostet 450 Franken.

  # Termine zum Vormerken

  | Datum | Zeit | Anlass | Ort |
  |---|---|---|---|
  | Sa 14. Nov | 10:00 | Apfelpressen | Dorfplatz |
  | Mi 18. Nov | 19:30 | Vereinsversammlung | Gemeindesaal |

  > [!NOTE]
  > Der Gemeindesaal ist bis zum 16. November wegen Reparaturen geschlossen; die Versammlung findet im Schulhaus statt.

  # Kurz gemeldet

  - **Kehricht:** Die Abfuhr wechselt ab Dezember auf den Dienstag.
  - **Chor:** Neue Mitglieder sind donnerstagabends willkommen.

  ---

  *Der Lindenhof-Bote erscheint viermal im Jahr. Beiträge an bote@example.org.*
---
::

::page-shots{caption="Die erste Seite der Newsletter-Vorlage: Titelkopf, Ausgabenzeile und ein Aufmacher in zwei Spalten."}
---
pages:
  - src: /template-thumbs/newsletter.webp
    alt: Erste Seite der Newsletter-Vorlage mit Titelkopf, Ausgabenzeile und einem Aufmacher in zwei Spalten.
---
::

::cta{title="Starte deine nächste Ausgabe mit dieser Vorlage." label="Vorlage verwenden" template="newsletter" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit der Newsletter-Vorlage: Text und Design Newsletter in einem.
::

## Was drin ist

- **Titelkopf und Ausgabenzeile.** Der Dokumenttitel wird zum Namen des Newsletters; die fette Zeile darunter trägt Nummer, Monat und Herausgeber, und die Linie darunter schliesst den Titelkopf ab.
- **Aufmacher.** 250 bis 400 Wörter, mit einem Zitat, das eine kurze Zeile des Beitrags gross wiederholt.
- **Zweiter Beitrag.** Ein kürzerer Text, der damit endet, wie Lesende mitmachen können.
- **Termine zum Vormerken.** Eine Tabelle der Anlässe in zeitlicher Reihenfolge und ein Hinweiskasten für eine praktische Mitteilung.
- **Kurz gemeldet.** Kurze Meldungen, die mit einem fetten Stichwort beginnen.
- **Fusszeile.** Wer den Newsletter schreibt, wie oft er erscheint und wohin Beiträge gehen.

Die Anleitungen unter den Überschriften sind Markdown-Kommentare: im Editor sichtbar, nie im PDF.

## Was Markdown dir hier bietet

- **Fotos.** Setze ein Bild direkt unter eine Schlagzeile mit `![Bildlegende.](bild){width=100%}`. Für das Hochladen von Bildern brauchst du ein Konto.
- **Zwei Spalten**, vom Design gesetzt, mit der Schlagzeile jedes Artikels über beide Spalten.
- **Mehrere Schreibende.** Die Kassierin trägt die Termine ein, der Redaktor den Aufmacher, alle im selben Dokument zur selben Zeit.

## Verschicken

Lade das PDF herunter und drucke es aus oder schicke es per E-Mail. Oder veröffentliche die Ausgabe als Webseite: ein Schnappschuss unter eigener Adresse, den alle im Browser lesen können, auch auf dem Handy. markoto verschickt keine E-Mails; es erstellt die Ausgabe, du verteilst sie.

## Fragen

::faq{json-ld}
---
items:
  - q: Verschickt markoto den Newsletter per E-Mail?
    a: Nein. markoto erstellt die Ausgabe als PDF oder als Webseite. Das PDF oder die Adresse der Seite verschickst du selbst.
  - q: Können mehrere Personen eine Ausgabe schreiben?
    a: Ja. Alle mit dem Link bearbeiten dasselbe Dokument live und sehen die Cursor der anderen. Kommentare und der Bearbeitungsverlauf sind enthalten.
  - q: Kann ich Fotos einfügen?
    a: Ja, mit einem Konto. Ziehe ein Bild ins Dokument oder nutze die Markdown-Bildsyntax mit einer Breite. Ohne Konto kannst du keine Bilder hochladen.
  - q: Kann ich dasselbe Layout für die nächste Ausgabe verwenden?
    a: Ja. Mit einem Konto dupliziere die letzte Ausgabe und ersetze den Text, oder behalte das Layout der Vorlage als gespeichertes Design.
---
::

::cta{title="Ein Vereins-Newsletter, der gedruckt auch so aussieht." label="Vorlage verwenden" template="newsletter"}
Kostenlos auf markoto.app, ohne Registrierung.
::
