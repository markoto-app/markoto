---
title: APA-Essay Vorlage in Markdown mit PDF
description: Eine APA-7-Vorlage für Hausarbeiten in Markdown mit Titelseite, These, Überschriften, Blockzitaten und einem doppelzeiligen Literaturverzeichnis als PDF.
keywords:
  - apa essay vorlage
  - apa 7 titelseite vorlage
  - essay vorlage markdown
  - apa 7 hausarbeit vorlage
  - essay in markdown schreiben
updated: '2026-11-19'
# Menu label once reviewed (group + order come from the English page).
navLabel: "APA-Essay-Vorlage"
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# APA-Essay Vorlage in Markdown

Ein Essay für einen Kurs muss oft APA 7 folgen: eine Titelseite mit Name, Institut, Kurs und Dozentin oder Dozent, doppelzeiliger Text, Überschriften in festem Stil und ein Literaturverzeichnis mit hängendem Einzug. Diese Vorlage setzt das alles für dich, damit du die Zeit auf das Argument verwenden kannst.

Unten siehst du den Anfang eines Essays, geschrieben mit dem Design **APA essay**. Die Titelseite kommt aus dem Dokumenttitel und den Feldern der Titelseite; der Text beginnt direkt darunter.

::try-it{theme="essay" height="760"}
---
source: |
  # Lehren gedruckte Bücher noch besser?

  Viele Studien berichten, dass Menschen gedruckten Text besser verstehen als Text am Bildschirm (Clinton, 2019). Wenige fragen, ob der Unterschied bleibt, sobald Lesende an Tablets gewöhnt sind. Dieses Essay argumentiert, dass das Medium weniger zählt als die Lesegewohnheiten, die damit einhergehen.

  # Belege aus Experimenten

  Delgado et al. (2018) fassten 54 Studien zusammen und fanden einen kleinen Vorteil für Papier, der mit der Länge des Textes wuchs.[^1] Der Vorteil verschwand, wenn Lesende am Bildschirm Notizen machen konnten.

  > Bildschirme sind nicht schlechter, weil sie Bildschirme sind. Sie sind schlechter, weil wir auf ihnen überfliegen.
  > (Fiktiver Autor, 2020, S. 12)

  # Gegenargumente

  Der stärkste Einwand lautet, Überfliegen sei keine Gewohnheit, sondern eine Reaktion auf die Oberfläche. Stimmt das, sollte eine bessere Oberfläche die Lücke schliessen.

  # Fazit

  Das Medium prägt, wie wir lesen, aber Lesende können ändern, wie sie es nutzen.

  # Literaturverzeichnis

  Clinton, V. (2019). Reading from paper compared to screens. *Journal of Research in Reading*, *42*(2), 288-325.

  Delgado, P., Vargas, C., Ackerman, R., & Salmeron, L. (2018). Don't throw away your printed books. *Educational Research Review*, *25*, 23-38.

  [^1]: Die Effektstärke betrug d = 0.21.
---
::

::page-shots{caption="Die erste Seite der APA-Essay-Vorlage: die Titelseite mit Name, Institut, Kurs und Dozentin oder Dozent."}
---
pages:
  - src: /template-thumbs/essay.webp
    alt: APA-Titelseite mit dem Titel der Arbeit, einem Autorennamen, einem Institut einer Universität, einem Kurs und einer Dozentin oder einem Dozenten.
---
::

::cta{title="Starte dein Essay mit dieser Vorlage." label="Vorlage verwenden" template="essay" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit der APA-Essay-Vorlage: Text und Design APA essay in einem. Jeder Abschnitt beginnt mit einer kurzen Anleitung.
::

## Was drin ist

- **Titelseite.** Der Titel, dein Name und im Feld für die Zugehörigkeit das Institut und die Universität, Kursnummer und Kursname sowie die Dozentin oder der Dozent, je eine pro Zeile. Das Datum kommt von der Titelseite. Der Titel wiederholt sich oben auf Seite 2, die Einleitung braucht deshalb keine Überschrift.
- **Einleitung mit These.** Die Anleitung verlangt einen Satz, der eine Position einnimmt, der jemand widersprechen könnte.
- **Hauptpunkte.** Eine Überschrift pro Argument: eine Behauptung, Belege mit Quellenangaben und wie die Belege die Behauptung stützen.
- **Gegenargumente.** Der stärkste Einwand, fair dargestellt, und deine Antwort.
- **Fazit und Literaturverzeichnis.** Das Literaturverzeichnis beginnt auf einer neuen Seite, doppelzeilig mit hängendem Einzug.

Die Anleitungen unter den Überschriften sind Markdown-Kommentare: im Editor und für den KI-Assistenten sichtbar, nie auf der Seite oder im PDF.

## Was Markdown dir hier bietet

- **Blockzitate.** Eine Zeile, die mit `>` beginnt, setzt ein Zitat von 40 Wörtern oder mehr als Block, ohne Anführungszeichen.
- **Fussnoten** mit `[^1]`, am Fuss der Seite gedruckt.
- **Überschriften** auf den Ebenen, die APA 7 verwendet, vom Design gesetzt.

## Was es nicht kann

Die Quellenangaben im Text, etwa (Autor, Jahr), und das Literaturverzeichnis schreibst du von Hand. markoto formatiert keine Zitate aus einer Datenbank und prüft die APA-Regeln nicht für dich. Frag deine Dozentin oder deinen Dozenten, wenn ein Layoutdetail im Design von den Vorgaben des Kurses abweicht; Schriften, Ränder und Kopfzeile änderst du im Dokumentdesign.

## Für wen es ist

Für Studierende, die ein Kurs-Essay oder eine kurze Arbeit in APA 7 schreiben, auf Englisch oder auf Deutsch (die Vorlage gibt es in beiden Sprachen). Teile den Link für eine Gegenlesung: Wer Bearbeitungsrechte hat, kann eine Stelle kommentieren. Mehr dazu unter [akademisches Schreiben](/de/academic-writing).

## Fragen

::faq{json-ld}
---
items:
  - q: Ist das das APA-7-Format für studentische Arbeiten?
    a: Es folgt der Struktur einer studentischen Arbeit nach APA 7: eine Titelseite mit Name, Zugehörigkeit, Kurs und Dozentin oder Dozent, doppelzeiliger Text, Überschriften der Ebene 1 und ein Literaturverzeichnis mit hängendem Einzug. Prüfe die Details anhand der Vorgaben deiner Dozentin oder deines Dozenten.
  - q: Formatiert markoto meine Quellenangaben?
    a: Nein. Die Quellenangaben im Text und das Literaturverzeichnis schreibst du von Hand. Es gibt weder eine Literaturdatenbank noch eine Zitierstil-Engine.
  - q: Kann ein Kommilitone oder eine Kommilitonin meinen Entwurf kommentieren?
    a: Ja. Wer Bearbeitungsrechte für das Dokument hat, kann eine Stelle kommentieren. Teile den Link mit Bearbeitungsrechten und schliesse die Threads ab, während du sie durchgehst.
  - q: Kann ich das Essay auf Deutsch schreiben?
    a: Ja. Die Vorlage gibt es auf Englisch und auf Deutsch; wähle die Dokumentsprache im Dialog für neue Dokumente.
---
::

::cta{title="Ein APA-Essay, das als Seiten herauskommt." label="Vorlage verwenden" template="essay"}
Kostenlos auf markoto.app, ohne Registrierung.
::
