---
title: Kollaborativer Markdown-Editor für Teams
description: Markdown gemeinsam in Echtzeit bearbeiten - Live-Cursor, Kommentare, jede Änderung mit Diff und Wiederherstellung, Workspaces mit Rollen. Kostenlos.
keywords:
  - kollaborativer markdown editor
  - markdown gemeinsam bearbeiten
  - markdown echtzeit zusammenarbeit
  - markdown editor für teams
  - geteilter markdown editor
# Menu label once reviewed (group + order come from the English page).
navLabel: "Gemeinsam bearbeiten"
updated: '2026-11-04'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). See docs/TRANSLATION-REVIEW.md.
reviewed: false
---

# Ein kollaborativer Markdown-Editor

Schicken Sie den Link zu einem Dokument, und alle, die ihn öffnen, bearbeiten gleichzeitig denselben Text. Sie sehen die Cursor und Namen der anderen, Änderungen erscheinen, während sie getippt werden, und es gibt weder einen Speichern-Knopf noch Merge-Konflikte. Kommentare, ein vollständiger Verlauf und Workspaces mit Rollen sind dabei.

::tour-clip{scene="collab"}
::

## Gleichzeitig schreiben

Zwei Personen können im selben Absatz tippen, ohne sich gegenseitig zu überschreiben: markoto führt die Änderungen zusammen, während sie entstehen. Die Leiste oben zeigt, wer im Dokument ist, und jede Person hat einen Cursor in ihrer eigenen Farbe. Das funktioniert auch ohne Konto: Ein anonymes Dokument können alle mit dem Link bearbeiten.

::flow-strip{id="two-writers-one-document" frames="07,10"}
---
captions:
  - Ein Absatz, den eine zweite Person tippt, erscheint im Editor der ersten. Die Avatare oben zeigen, wer im Dokument ist.
  - Ein Kommentar der zweiten Person erscheint in der Seitenleiste, verankert an der Zeile, um die es geht.
---
::

## In Kommentaren diskutieren

Markieren Sie eine Passage und fügen Sie einen Kommentar hinzu. Der Thread ist an diesen Worten verankert und folgt ihnen, wenn sich der Text darum herum ändert. Andere antworten darunter; in einem Workspace können Sie Mitglieder mit `@` erwähnen. Ein erledigter Thread rückt zur Seite, bleibt aber lesbar. Ist der KI-Assistent eingerichtet, bitten Sie ihn mit `@markoto` in einem Kommentar um eine Antwort oder eine Änderung.

::flow-strip{id="have-a-discussion" frames="11,15"}
---
captions:
  - Eine Antwort erscheint unter dem Kommentar, sobald sie abgeschickt ist.
  - Erledigte Threads wandern in einen eigenen Bereich, wo sie weiterhin lesbar sind.
---
::

## Jede Änderung, mit Diff

Der Tab «Aktivität» listet jede Bearbeitung mit Person, Zeitpunkt und Anzahl geänderter Zeilen. Öffnen Sie einen Eintrag, um den Diff zu sehen. Kommentare, Änderungen an Titel und Theme sowie die Bearbeitungen der KI stehen in derselben Liste. **Wiederherstellen** setzt das Dokument für alle auf den Stand unmittelbar vor einer Änderung zurück, und die Wiederherstellung erscheint selbst in der Liste, sodass auch sie rückgängig zu machen ist.

::flow-strip{id="see-what-changed-in-past-edits" frames="05" caption="Ein geöffneter Eintrag im Tab «Aktivität» mit seinem Diff: hinzugefügte Zeilen grün, entfernte rot."}
::

::flow-strip{id="restore-an-earlier-version" frames="09" caption="Nach einer Wiederherstellung: Der Text ist zurück, und die Wiederherstellung steht wie jede andere Änderung im Tab «Aktivität»."}
::

Mehr dazu in der Dokumentation (auf Englisch): [Änderungen ansehen](/docs/history/see-changes) und [eine frühere Version wiederherstellen](/docs/history/restore).

## Workspaces und Rollen

Ein Workspace enthält die Dokumente eines Teams. Sie laden Personen per E-Mail ein, und sie treten bei, sobald sie die Einladung annehmen. Es gibt drei Rollen: **Administratoren** verwalten Mitglieder und den Workspace, **Bearbeiter** schreiben und kommentieren, **Betrachter** lesen. Ein Workspace behält immer mindestens einen Administrator.

::flow-strip{id="roles-inside-a-workspace" frames="08" caption="Die Mitgliederliste: Jede Person hat eine Rolle, und ein Administrator ändert sie über das Feld neben dem Namen."}
::

Dokumente ausserhalb eines Workspace werden per Link geteilt. Die Eigentümerin oder der Eigentümer wählt einen von vier Modi: privat, alle mit dem Link können bearbeiten, alle mit dem Link können lesen, oder mit Passwort geschützt. Siehe die Dokumentation zu [Teilen](/docs/sharing) und [Workspaces](/docs/workspaces) (auf Englisch).

## Die KI arbeitet sichtbar mit

Bearbeitet der KI-Assistent ein Dokument, tritt er bei wie eine weitere Person: Sein Cursor und seine Änderungen erscheinen für alle live, im Rot von markoto, und seine Bearbeitungen stehen im Verlauf wie die aller anderen. Was er geändert hat, können Sie wiederherstellen. Die KI braucht ein Konto; auf markoto.app läuft sie mit einem kleinen monatlichen Kontingent oder mit [Ihrem eigenen KI-Anbieter](/docs/account/ai-provider).

## Was es nicht kann

- **Kein Änderungsmodus.** Es gibt keine nachverfolgten Änderungen zum Annehmen oder Ablehnen. Wer Bearbeitungsrecht hat, ändert den Text direkt, und der Verlauf bewahrt jede Version.
- **Kein Offline-Modus.** Ein Dokument braucht zum Öffnen eine Verbindung. Bricht sie beim Tippen kurz ab, ist das kein Problem: Ihre Änderungen werden synchronisiert, sobald Sie wieder online sind.
- **Markdown, keine Textverarbeitung.** Alle bearbeiten den Markdown-Quelltext; die Seitenvorschau steht daneben.

## Für Ihr Team selbst betreiben

markoto läuft auch auf Ihrem eigenen Server, mit Anmeldung über den Identity Provider Ihres Unternehmens. Siehe [markoto selbst hosten](/self-hosted-markdown-editor) (auf Englisch).

Sie wählen zwischen Werkzeugen? Sehen Sie markoto neben [HackMD](/compare/hackmd), [HedgeDoc](/compare/hedgedoc) und [Google Docs](/compare/google-docs) (auf Englisch). Die Limits des kostenlosen Plans stehen auf der [Preisseite](/pricing).

## Fragen

::faq{json-ld}
---
items:
  - q: Ist die Zusammenarbeit in Echtzeit kostenlos?
    a: Ja. Gemeinsames Bearbeiten in Echtzeit, Kommentare und Verlauf gehören auf markoto.app zum kostenlosen Plan, und anonyme Dokumente lassen sich ohne Konto gemeinsam bearbeiten.
  - q: Wie viele Personen können ein Dokument gleichzeitig bearbeiten?
    a: Es gibt keine Obergrenze pro Dokument. Alle mit einem Bearbeitungslink oder mit der Rolle Bearbeiter im Workspace können mitmachen.
  - q: Brauchen die anderen ein Konto?
    a: Nicht für ein Dokument, das mit einem Link zum Bearbeiten oder Lesen geteilt wird. Um einem Workspace beizutreten, braucht eine Person ein Konto mit der eingeladenen E-Mail-Adresse.
  - q: Sehe ich, wer was geändert hat?
    a: Ja. Der Tab Aktivität listet jede Änderung mit Person und Zeitpunkt, zeigt den Diff und kann das Dokument auf den Stand vor jeder Änderung zurücksetzen.
  - q: Gibt es einen Änderungsmodus zum Nachverfolgen?
    a: Nein. Bearbeitungen gehen direkt in den Text. Der Verlauf bewahrt jede Version, sodass sich eine Änderung nachträglich prüfen und rückgängig machen lässt.
  - q: Können wir markoto selbst hosten?
    a: Ja. markoto lässt sich mit Docker Compose und einem Skript auf einem Linux-Server installieren, mit Anmeldung über Ihren eigenen OpenID-Connect-Anbieter.
---
::

::cta{title="Schreiben Sie gemeinsam, ab sofort." secondary-label="Dokumentation zur Zusammenarbeit" secondary-to="/docs/workspaces/live-collab"}
Dokument erstellen und den Link verschicken. Ihr Gegenüber braucht kein Konto.
::
