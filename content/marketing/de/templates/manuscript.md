---
title: Romanmanuskript Vorlage in Markdown
description: Manuskript Vorlage in Markdown für Roman oder Erzählband. Titelseite, Motto, Kapitel auf neuen Seiten, Szenenwechsel und fertig als PDF zum Weitergeben.
keywords:
  - romanmanuskript vorlage
  - roman schreiben vorlage
  - manuskript vorlage markdown
  - manuskript format roman
  - roman in markdown schreiben
# Menu label once reviewed (group + order come from the English page).
navLabel: "Romanmanuskript Vorlage"
updated: '2026-11-19'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Romanmanuskript Vorlage in Markdown

Ein Manuskript hat ein paar Formatregeln, die zählen, und viele, die es nicht tun. Diese Vorlage hält sich an die wichtigen: eine Titelseite, Kapitel, die auf einer neuen Seite beginnen, einen Szenenwechsel zwischen den Szenen und den Buchtitel oben auf den Seiten. Du schreibst die Geschichte in einfachem Markdown, und das Design **Manuskript** übernimmt das Layout.

Unten siehst du den Anfang eines erfundenen Romans. Ändere den Text, und die Seiten ziehen mit.

::try-it{theme="manuscript" height="760"}
---
source: |
  # Der Salzweg

  > Der Weg erinnert sich an jeden Fuss, der ihn verlassen hat.
  >
  > Altes Sprichwort

  # Die Tochter des Fährmanns

  Mara zählte die Lampen am anderen Ufer zweimal, bevor sie sich zu glauben erlaubte, dass eine fehlte.

  «Vater», sagte sie. «Das Licht des Stallmeisters ist aus.»

  Er sah nicht von dem Seil auf, das er flickte. «Dann schläft der Stallmeister.»

  * * *

  Um Mitternacht wusste es das ganze Dorf. Am Morgen war die Fähre fort.

  # Was das Wasser behielt

  Am neunten Tag gab der Fluss das Boot zurück, leer, mit einem einzelnen Mantel, sauber gefaltet auf der Bank.
---
::

::page-shots{caption="Die erste Seite der Manuskript-Vorlage: die Titelseite mit Titel, Untertitel und Autorin oder Autor."}
---
pages:
  - src: /template-thumbs/manuscript.webp
    alt: Titelseite der Manuskript-Vorlage mit einem Buchtitel, dem Untertitel Ein Roman und einem Autorennamen.
---
::

::cta{title="Starte dein Manuskript mit dieser Vorlage." label="Diese Vorlage verwenden" template="manuscript" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit ausgewählter Manuskript-Vorlage: Text und Design Manuskript in einem. Sie beginnt mit einer Titelseite, einem optionalen Motto und zwei Kapiteln.
::

## Was drin ist

- **Titelseite.** Titel, Untertitel („Ein Roman“) und Autorin oder Autor, eingestellt unter **Titelseite** im Dokument-Design. Der Buchtitel steht ausserdem oben auf den Seiten.
- **Motto.** Ein optionales Zitat allein auf seiner Seite, die Quelle in einem eigenen Absatz.
- **Kapitel.** Jedes Kapitel ist eine Überschrift der obersten Ebene ohne Nummer. Das Design nummeriert die Kapitel, beginnt jedes auf einer neuen Seite und setzt die ersten Wörter in Kapitälchen. Setze `[[toc]]` dorthin, wo das Buch ein Inhaltsverzeichnis braucht.
- **Szenenwechsel.** Eine Zeile mit `* * *` oder `---` innerhalb eines Kapitels wird zu drei gesperrten Sternchen, und der nächste Absatz beginnt ohne Einzug.
- **Hinweise.** Eine kurze Notiz unter jeder Überschrift dazu, wie du ein Kapitel eröffnest, beendest und Dialoge setzt. Sie sind Markdown-Kommentare: im Editor und für den KI-Assistenten sichtbar, nie auf der Seite.

## Das Buch in markoto schreiben

- **Kapitel verschieben.** Bitte die KI, zwei Kapitel zu tauschen, und sie verschiebt jedes mit allen Szenen, in einer Änderung, die du rückgängig machen kannst.
- **Wort- und Seitenzahl.** Die Statusleiste zeigt die Wörter im Dokument und in der Vorschau die Anzahl Seiten.
- **Jeder Entwurf bleibt.** Jede Änderung wird festgehalten, und du kannst einen früheren Stand wiederherstellen. Im kostenlosen Plan auf markoto.app reicht der Verlauf 30 Tage zurück; eine selbst gehostete Instanz hat keine Grenze.
- **Eine Datei, die dir gehört.** Der Text ist eine Markdown-Datei, die du jederzeit herunterladen kannst.

## Was es nicht kann

Ein Manuskript ist hier ein einziges Dokument. Es gibt keinen Manuskriptordner, der Kapiteldateien zu einem Buch zusammensetzt, und keine Korkwand und keine Schreibziele. markoto erzeugt ein PDF, eine Markdown-Datei und, wenn du willst, eine veröffentlichte Webseite. Einen ausführlicheren Vergleich mit einem spezialisierten Romanschreibprogramm findest du unter [markoto vs Scrivener](/compare/scrivener) (auf Englisch). Mehr zum Thema: [Software zum Romanschreiben](/de/novel-writing-software).

## Fragen

::faq{json-ld}
---
items:
  - q: Beginnt jedes Kapitel auf einer neuen Seite?
    a: Ja. Das Design Manuskript beginnt jede Überschrift der obersten Ebene auf einer neuen Seite, nummeriert sie und setzt die ersten Wörter in Kapitälchen.
  - q: Wie markiere ich einen Szenenwechsel?
    a: Setze eine Zeile mit * * * oder --- zwischen die Szenen. Das Design setzt drei gesperrte Sternchen und beginnt den nächsten Absatz ohne Einzug.
  - q: Kann ich jedes Kapitel in einer eigenen Datei führen?
    a: Nicht als ein Buch. Ein Manuskript ist ein Dokument, die Kapitel sind Überschriften. Du kannst Kapitel als einzelne Dokumente in einem Ordner führen, aber markoto fügt sie nicht zu einem PDF zusammen.
  - q: Können Testleserinnen und Testleser ein Kapitel kommentieren?
    a: Ja. Wer Bearbeitungsrechte am Dokument hat, kann eine Stelle kommentieren, antworten und Threads abschliessen. Mit einem Link nur zum Lesen können Leute lesen, aber nicht kommentieren.
---
::

::cta{title="Schreib das Buch. Die Seiten erledigen sich von selbst." label="Diese Vorlage verwenden" template="manuscript"}
Kostenlos auf markoto.app, ohne Registrierung.
::
