---
title: Bereitschafts-Runbook Vorlage in Markdown
description: Runbook Vorlage in Markdown mit Schweregraden, einem Ablauf pro Alarm, Eskalationskontakten und Schnellreferenz. Nummerierte Abschnitte, PDF für den Pager.
keywords:
  - runbook vorlage
  - bereitschafts-runbook
  - incident runbook vorlage
  - runbook markdown
  - alarm runbook vorlage
# Menu label once reviewed (group + order come from the English page).
navLabel: "Runbook Vorlage"
updated: '2026-11-19'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Bereitschafts-Runbook Vorlage in Markdown

Ein Runbook wird um drei Uhr nachts von jemandem gelesen, der es nicht geschrieben hat. Diese Vorlage ist für diese Leserin oder diesen Leser gebaut: zuerst die Schweregrade, dann ein Ablauf pro Alarm, benannt so, wie der Pager den Alarm nennt, mit den Befehlen in Codeblöcken, dann Eskalationskontakte und eine Schnellreferenz mit Dashboards und Befehlen.

Unten siehst du ein kurzes Runbook für einen erfundenen Dienst. Das Design nummeriert die Abschnitte, damit „siehe 3.1“ in einem Call funktioniert.

::try-it{theme="runbook" height="760"}
---
source: |
  # Runbook Checkout-Dienst

  # So benutzt du dieses Runbook

  Für die Ingenieurin oder den Ingenieur in Bereitschaft für den Checkout-Dienst. Suche den Alarm, der dich geweckt hat, unter Abläufe und folge den Schritten der Reihe nach.

  > [!IMPORTANT]
  > Sind Kundinnen und Kunden betroffen und du hast die Ursache nach 15 Minuten nicht gefunden, rufe einen Incident aus und alarmiere die Incident-Leitung.

  # Schweregrade

  | Stufe | Definition | Reaktion |
  |---|---|---|
  | SEV-1 | Kunden können nicht bezahlen | Incident-Leitung alarmieren |
  | SEV-2 | Zahlungen langsam oder teilweise fehlerhaft | Innerhalb einer Stunde beheben |

  # Abläufe

  ## CheckoutErrorRateHigh

  **Alarm:** Mehr als 2 % der Checkout-Requests schlagen 5 Minuten lang fehl.

  1. Prüfe im Dashboard, welche Komponente ausfällt.
  2. Sieh dir das letzte Deployment an:
     ```bash
     kubectl rollout history deployment/checkout
     ```
  3. Ist das Deployment die Ursache, mache es rückgängig.
  4. Bestätige, dass der Alarm innert weniger Minuten verschwindet. Wenn nicht, eskaliere.

  > [!WARNING]
  > Starte die Payment-Worker nicht neu, solange Bestellungen laufen.

  # Eskalation

  | Bereich | Erster Kontakt | Zeiten |
  |---|---|---|
  | Incident-Leitung | Manager in Bereitschaft | 24/7 |
  | Zahlungen | Teamleitung Zahlungen | 08:00-18:00 |
---
::

::page-shots{caption="Die erste Seite der Runbook-Vorlage: der Titelblock mit Diensten, Team und Datum, dann der erste Abschnitt."}
---
pages:
  - src: /template-thumbs/runbook.webp
    alt: Erste Seite der Runbook-Vorlage mit einem Titelblock, der die abgedeckten Dienste auflistet, und einem nummerierten ersten Abschnitt.
---
::

::cta{title="Starte dein Runbook mit dieser Vorlage." label="Diese Vorlage verwenden" template="runbook" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit ausgewählter Runbook-Vorlage: Text und Design Runbook in einem. Jeder Abschnitt beginnt mit einem kurzen Hinweis.
::

## Was drin ist

- **Titelblock.** Der Titel, die abgedeckten Dienste, das zuständige Team und das Datum. Das Datum steht auf jeder Seite, weil Ausdrucke veralten.
- **So benutzt du dieses Runbook.** Für wen es gedacht ist und wie ein Ablauf aufgebaut ist, mit einem Warnkasten dazu, wann du einen Incident ausrufst.
- **Vor deiner Schicht.** Eine Checkliste für die Übergabe: Zugänge funktionieren, Zugangsdaten sind gültig, der Pager erreicht dich.
- **Schweregrade.** Eine Zeile pro Stufe mit der Definition aus Kundensicht, einem Beispiel und der Reaktion.
- **Abläufe.** Ein Abschnitt pro Alarm, genau so benannt wie der Alarm im Pager, mit Alarmbedingung, nummerierten Schritten, Befehlen in Codeblöcken und Warnkästen dort, wo ein Schritt etwas verschlimmern kann.
- **Eskalation, nach dem Incident und Schnellreferenz.** Wen du anrufst, was vor dem Abschluss des Incidents zu tun ist, und Tabellen mit Dashboards und Befehlen.

Die Hinweise unter den Überschriften sind Markdown-Kommentare: im Editor und für den KI-Assistenten sichtbar, nie auf der Seite oder im PDF.

## Warum es für ein Runbook taugt

- **Abschnittsnummern vom Design.** Das Design nummeriert die Abschnitte, du sagst im Call also „Abschnitt 3.2“, und die Nummern stimmen auch, wenn du einen Abschnitt verschiebst.
- **Codeblöcke** mit Syntaxhervorhebung, für Befehle, die man kopiert.
- **Aufgabenlisten**, die Lesende in der Vorschau abhaken.
- **Ein PDF für den Pager.** Exportiere ein seitenweises PDF mit Titel und Datum auf jeder Seite, drucke es aus oder hänge es an die Bereitschaftsübergabe.
- **Mehrere Zuständige.** Jedes Team bearbeitet seine eigenen Abläufe im selben Dokument. Das Aktivitätsprotokoll zeigt, wer einen Schritt wann geändert hat, und ein früherer Stand lässt sich wiederherstellen.

## Fragen

::faq{json-ld}
---
items:
  - q: Sind die Abschnitte nummeriert?
    a: Ja. Das Design Runbook nummeriert die Abschnitte, damit man im Call „siehe 3.2“ sagen kann. Die Nummern tippst du nie selbst.
  - q: Kann ich Befehle ins Runbook schreiben?
    a: Ja. Nimm Codeblöcke, wenn du willst mit Sprache für die Syntaxhervorhebung. Mehrzeilige Befehle bleiben zusammen.
  - q: Ist es mit unserem Pager oder Monitoring verbunden?
    a: Nein. markoto hat keine Anbindung an Pager- oder Monitoring-Werkzeuge. Benenne jeden Ablauf genau so wie den Alarm, damit man danach suchen kann.
  - q: Können mehrere Teams ein Runbook bearbeiten?
    a: Ja. Alle mit Bearbeitungsrechten schreiben gleichzeitig, kommentieren einen Schritt, und das Aktivitätsprotokoll hält fest, wer was geändert hat.
---
::

::cta{title="Ein Runbook, dem man um 3 Uhr nachts folgen kann." label="Diese Vorlage verwenden" template="runbook"}
Kostenlos auf markoto.app, ohne Registrierung.
::
