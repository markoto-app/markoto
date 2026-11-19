---
title: "Roman schreiben: Software im Browser"
description: Roman in Markdown im Browser schreiben. Kapitel auf neuen Seiten, Kommentare von Lesenden, ein PDF wie die Vorschau und eine KI, die nur auf Wunsch eingreift.
keywords:
  - roman schreiben software
  - roman schreiben online
  - schreibprogramm für romane
  - manuskript schreiben software
  - manuskript mit testlesern teilen
# Menu label once reviewed (group + order come from the English page).
navLabel: "Roman schreiben"
updated: '2026-11-19'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Roman schreiben mit einer Software, die im Browser läuft

Du schreibst das Buch als reinen Text, in Markdown. markoto setzt es beim Tippen als Manuskriptseiten, lässt Lesende die Stellen kommentieren, die sie meinen, und liefert dir ein PDF, das aussieht wie die Vorschau. Wenn du Hilfe willst, kann ein KI-Assistent einen Absatz straffen oder eine Frage zu deinen Notizen beantworten. Er tut das nur auf Wunsch, und jede seiner Änderungen lässt sich rückgängig machen.

::tour-clip{scene="write"}
::

## Ein Manuskript, keine Webseite

Die Vorlage **Romanmanuskript** setzt das Buch so, wie ein Manuskript gesetzt wird: eine Titelseite mit Titel und deinem Namen, ein optionales Motto allein auf einer Seite und Kapitel, die jeweils auf einer neuen Seite beginnen und vom Layout nummeriert werden. Ein Kapitel ist eine Überschrift, also musst du nichts neu nummerieren, wenn du eines verschiebst. Ein Szenenwechsel ist eine Zeile mit `* * *`; das Layout setzt sie als drei Sternchen mit Abstand und beginnt den nächsten Absatz ohne Einzug.

::page-shots{caption="Die Titelseite der Manuskriptvorlage."}
---
pages:
  - src: /template-thumbs/manuscript.webp
    alt: Titelseite der Manuskriptvorlage mit dem Buchtitel, dem Untertitel «Ein Roman» und einem Autorennamen.
---
::

Die Statusleiste zeigt beim Schreiben deine Wortzahl und in der Vorschau die Seitenzahl. Schriften, Ränder und die Kopfzeile stellst du im Dokument-Theme ein, wenn du ein anderes Aussehen willst. Mehr dazu: die [Vorlage Romanmanuskript](/de/templates/manuscript).

::cta{title="Fang ein Manuskript an." label="Diese Vorlage verwenden" template="manuscript" secondary-label="Dokumentation lesen (auf Englisch)" secondary-to="/docs/getting-started/templates"}
Öffnet den Dialog für neue Dokumente mit der Vorlage Romanmanuskript. Auf markoto.app kostenlos, ohne Registrierung.
::

## Kapitel teilen und Kommentare sammeln

Schick den Link, und deine Lesenden sehen das Dokument in ihrem Browser: ohne Installation, ohne Konto zum Lesen. Sie kommentieren eine Stelle, du antwortest, und wenn der Punkt erledigt ist, schliesst du den Thread. Kommentare bleiben an ihren Wörtern haften, auch wenn du drumherum umschreibst.

::flow-strip{id="have-a-discussion" frames="07,11"}
---
captions:
  - Ein Kommentar sitzt an der Stelle, um die es geht, mit gelber Unterstreichung.
  - Eine Antwort erscheint darunter, sobald sie abgeschickt ist.
---
::

Das solltest du wissen, bevor du den Link verschickst:

- **Kommentieren braucht Bearbeitungsrechte.** Mit einem Nur-Lesen-Link können Leute lesen, aber nicht kommentieren. Ein Link mit Bearbeitungsrechten erlaubt das Kommentieren, aber auch das Ändern des Textes; im Verlauf siehst du jede Änderung und stellst einen früheren Stand wieder her.
- **Ein Passwort** kann den Link schützen, sodass nur Personen, denen du es gibst, das Dokument öffnen.
- **Zum Lesen ist kein Konto nötig.** Wer kommentieren will, öffnet den Link ebenfalls im Browser.

## Ein PDF wie in der Vorschau

**Datei › Exportieren › PDF** lädt die Seiten herunter, die du in der Vorschau gesehen hast, mit Titelseite, Kapiteln auf neuen Seiten und Kopfzeile. Schick es an jemanden, der Papier bevorzugt, oder druck es aus. Das PDF entsteht auf unserem Server aus dem gespeicherten Dokument, deshalb dauert es beim ersten Mal ein paar Sekunden.

::flow-strip{id="polished-pdf" frames="07" caption="Ein heruntergeladenes PDF: das Deckblatt und die erste Textseite, so wie sie in der Vorschau aussahen."}
::

## Die KI als Lektorat, nicht als Ghostwriter

Der Assistent sitzt in einer Eingabeleiste am unteren Rand des Dokuments. Er bearbeitet deinen Text, wenn du ihn darum bittest, an den Stellen, auf die du zeigst.

- **Eine Stelle umschreiben.** Markiere einen Absatz und sag, was du willst: kürzer, ruhiger, weniger Wiederholung. Die Auswahl wird an Ort und Stelle ersetzt, die Absätze darum herum bleiben unberührt.
- **In einem Kommentar nach einer Stelle fragen.** Erwähne `@markoto` in einem Kommentar zu einem Satz, und er antwortet im Thread: Klingt dieser Absatz wie die Figur aus Kapitel 2? Was setzt dieser Satz beim Lesen voraus?
- **Viele Kapitel auf einmal ändern.** Übersetze die Kapitel 2 bis 5 oder ändere durchgehend den Ton. Die KI probiert die Änderung an einer Stichprobe, sagt dir, wie viele Abschnitte sie ändert und wie lange das dauert, und arbeitet sie dann ab, während du weiterschreibst. Du kannst abbrechen und den ganzen Auftrag rückgängig machen.
- **Prüfen, was du geschrieben hast.** Jede KI-Änderung erscheint im Tab Aktivität mit einem Diff und einer Schaltfläche Wiederherstellen.

::flow-strip{id="rewrite-a-selection-with-the-ai" frames="07" caption="Der langatmige Absatz ist jetzt ein kurzer Satz, an Ort und Stelle."}
::

Die KI schreibt von sich aus kein Buch aus einer Eingabe und ändert nie etwas, wenn du nicht darum bittest. Nutze sie so wenig oder so viel, wie du magst; der Chat kann auch über deinen eigenen KI-Anbieter laufen (Einstellungen › KI-Anbieter), und ganz ohne KI funktioniert der Editor genauso.

## Recherche-Hilfe

Notizen, Interviews, eine historische Quelle: Lade sie in den Tab **Wissen** eines Workspace hoch (PDF, Word, Folien, Tabellen, HTML, Markdown und reiner Text). markoto liest sie und indexiert sie nach Bedeutung und nach exakten Wörtern. Wenn du der KI eine Frage dazu stellst, durchsucht sie zuerst deine Dateien und antwortet aus dem, was sie findet, statt aus dem Nichts.

::flow-strip{id="knowledge-grounded-ai" frames="20" caption="Die KI antwortet aus einer hochgeladenen Datei und nennt die Fakten, die nur in dieser Datei stehen."}
::

Sie kann auch im Web suchen und eine verlinkte Seite lesen, und sie sagt, woher die Antwort stammt. Der Wissensspeicher im kostenlosen Tarif auf markoto.app ist klein, eine Handvoll Dateien; auf einer selbst gehosteten Instanz ist er so gross, wie die Betreiberin oder der Betreiber es festlegt.

## Jeder Entwurf bleibt erhalten

Jede Änderung wird festgehalten, egal wer sie gemacht hat. Stelle das Buch so wieder her, wie es gestern war, oder vergleiche, was eine lesende Person geändert hat. Im kostenlosen Tarif von markoto.app reicht der Verlauf 30 Tage zurück; eine selbst gehostete Instanz hat kein Limit. Der Text ist eine Markdown-Datei, die du jederzeit herunterladen kannst, und ein Manuskript, das du schon in Word hast, kannst du importieren (Datei › Importieren).

## Wo es aufhört

- **Ein Manuskript ist ein Dokument.** Kapitel sind Überschriften darin. Du kannst Kapitelentwürfe als einzelne Dokumente in einem Ordner behalten, aber markoto setzt sie nicht zu einem Buch zusammen.
- **Keine Pinnwand, kein Binder, keine Schreibziele.** Es gibt keine Karteikarten, keinen Recherche-Ordner neben dem Entwurf und kein tägliches Wortziel. Die Statusleiste zählt Wörter.
- **Ausgabe ist ein PDF, eine Markdown-Datei oder eine veröffentlichte Webseite.** Für ein gesetztes Buch für den Druck brauchst du nach dem Schreiben ein Satzprogramm.
- **Bilder brauchen ein Konto.** Ohne Konto kannst du keine Bilder in ein Dokument hochladen.

Einen ausführlicheren Vergleich findest du unter [markoto vs Scrivener](/compare/scrivener) (auf Englisch).

## Standardmässig privat, in der EU gehostet

Mit einem Konto sind deine Dokumente privat, bis du sie teilst. markoto.app ist in der EU gehostet, betrieben von einer Schweizer Firma; die Dokumente liegen in Frankreich. Die KI nutzt Anbieter aus der EU und sendet ihnen nichts, solange du keine KI-Funktion verwendest. Details stehen auf der Seite [EU-Hosting](/de/eu-markdown-editor).

## Fragen

::faq{json-ld}
---
items:
  - q: Kann ich einen ganzen Roman in markoto schreiben?
    a: Ja. Ein Manuskript ist ein Markdown-Dokument mit Kapiteln als Überschriften, gesetzt als Manuskriptseiten, mit Titelseite und Kapiteln, die auf neuen Seiten beginnen. Jede Änderung bleibt im Verlauf erhalten.
  - q: Können Testlesende meine Kapitel kommentieren?
    a: Ja. Wer Bearbeitungsrechte für das Dokument hat, kann eine Stelle kommentieren, antworten und Threads schliessen. Ein Nur-Lesen-Link erlaubt keine Kommentare. Weil Bearbeitungsrechte auch das Ändern des Textes erlauben, siehst du im Verlauf, was geändert wurde, und kannst es rückgängig machen.
  - q: Schreibt die KI mein Buch?
    a: Nur wenn du sie bittest, etwas zu schreiben. Sie bearbeitet deinen Text, wenn du sie ansprichst oder in einem Kommentar erwähnst: einen Absatz umschreiben, eine Frage zu einer Stelle beantworten, Kapitel übersetzen. Jede Änderung wird festgehalten und lässt sich rückgängig machen, und du kannst markoto ganz ohne KI nutzen.
  - q: Kann ich meine Recherche hochladen und Fragen dazu stellen?
    a: Ja, in einem Workspace. Lade Dateien in den Tab Wissen, und die KI antwortet daraus, wenn du fragst. Der kostenlose Tarif auf markoto.app erlaubt ein paar Dateien; eine selbst gehostete Instanz erlaubt mehr.
  - q: Kann ich mein Manuskript aus markoto mitnehmen?
    a: Ja. Lade den Text jederzeit als Markdown-Datei herunter oder exportiere das PDF mit Seiten.
  - q: Wo wird mein Manuskript gespeichert?
    a: markoto.app ist in der EU gehostet, mit Dokumenten in Frankreich, und wird von einer Schweizer Firma betrieben. Du kannst markoto auch auf deinem eigenen Server betreiben.
---
::

::cta{title="Schreib das Buch. Die Seiten erledigen sich von selbst." secondary-label="Alle Vorlagen" secondary-to="/templates"}
Auf markoto.app kostenlos, zum Start ist keine Registrierung nötig.
::
