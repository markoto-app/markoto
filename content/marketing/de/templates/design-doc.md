---
title: Designdokument und RFC Vorlage in Markdown
description: Design Doc Vorlage in Markdown mit Statuskopf, Zielen, Vorschlag mit Diagramm, Alternativen, Entscheiden und Rollout. Mit Kommentaren prüfen, als PDF.
keywords:
  - design doc vorlage
  - rfc vorlage
  - designdokument vorlage
  - technisches designdokument vorlage
  - design doc pdf
# Menu label once reviewed (group + order come from the English page).
navLabel: "Designdokument Vorlage"
updated: '2026-11-19'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Designdokument und RFC Vorlage in Markdown

Ein Design Doc schlägt eine einzige Änderung vor, und Reviewer können Abschnitt für Abschnitt zustimmen oder widersprechen. Diese Vorlage hat die Abschnitte, die das möglich machen: einen Statuskopf, Motivation, Ziele und Nicht-Ziele, den Vorschlag, die geprüften Alternativen, die Entscheide, um die du bittest, einen Rollout-Plan, Risiken und offene Fragen.

Unten siehst du ein kurzes Design Doc zu einer erfundenen Änderung. Das Diagramm ist ein Mermaid-Block, der im Quelltext steht.

::try-it{theme="design-doc" height="760"}
---
source: |
  # E-Mail-Versand über eine Queue

  | | |
  |---|---|
  | **Status** | In Review |
  | **Autorin** | Priya |
  | **Reviewer** | Jonas (Plattform) |
  | **Entscheid bis** | 2026-12-02 |

  # Zusammenfassung

  Wer E-Mails direkt im Request versendet, macht den Checkout langsam und verliert E-Mails, wenn der Anbieter in ein Timeout läuft. Wir schlagen vor, E-Mails in eine Queue zu legen und von einem Worker versenden zu lassen.

  # Ziele

  - Checkout-Latenz unter 300 ms im 95. Perzentil.
  - Keine verlorene E-Mail bei einem Ausfall des Anbieters von bis zu einer Stunde.

  ## Nicht-Ziele

  - Den E-Mail-Anbieter wechseln.

  # Vorschlag

  ```mermaid
  flowchart LR
    A[Checkout] --> B[(Queue)]
    B --> C[E-Mail-Worker]
    C --> D[Anbieter]
  ```

  # Geprüfte Alternativen

  | | A: Im Request senden | **B: Queue (vorgeschlagen)** | C: Nichts tun |
  |---|---|---|---|
  | Aufwand | Keiner | 2 Wochen | Keiner |
  | Risiko | Verlorene E-Mails | Gering | Verlorene E-Mails |

  # Entscheide

  **D1.** Die bestehende Job-Queue verwenden, keinen neuen Dienst.

  # Offene Fragen

  - [ ] Wiederholen wir 24 Stunden oder 72? (Zuständig: Jonas)
---
::

::page-shots{caption="Die erste Seite der Design-Doc-Vorlage: Titelblock und Statuskopf."}
---
pages:
  - src: /template-thumbs/design-doc.webp
    alt: Erste Seite der Design-Doc-Vorlage mit einem Titelblock, einer Statustabelle und dem Abschnitt Zusammenfassung.
---
::

::cta{title="Starte dein Designdokument mit dieser Vorlage." label="Diese Vorlage verwenden" template="design-doc" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit ausgewählter Design-Doc-Vorlage: Text und Design Design doc in einem. Jeder Abschnitt beginnt mit einem kurzen Hinweis.
::

## Was drin ist

- **Statuskopf.** Eine Tabelle mit Status (Entwurf, In Review, Angenommen, Abgelehnt, Ersetzt), Autorinnen und Autoren, Reviewern, Daten, Tracking-Issue und der Frist für den Entscheid.
- **Zusammenfassung und Motivation.** Ein Absatz für alle, die sonst nichts lesen, dann der aktuelle Stand, die Belege und die Randbedingungen.
- **Ziele und Nicht-Ziele.** Ergebnisse, die du nach dem Rollout prüfen kannst, und was du bewusst weglässt.
- **Vorschlag.** Ein Überblick mit Diagramm, dann ein Abschnitt pro Teil des Designs: Datenmodell, API, Migration, Fehlerbehandlung.
- **Geprüfte Alternativen.** Eine Vergleichstabelle mit der vorgeschlagenen Option in Fett, inklusive „nichts tun“.
- **Entscheide.** Die Entscheide, die Reviewer annehmen sollen, nummeriert als D1, D2, damit Kommentare darauf verweisen können.
- **Rollout, Risiken und offene Fragen.** Phasen mit Abschlusskriterien, eine Risikotabelle und eine Aufgabenliste mit Fragen und Zuständigen.

Die Hinweise unter den Überschriften sind Markdown-Kommentare: im Editor und für den KI-Assistenten sichtbar, nie auf der Seite oder im PDF.

## Dort prüfen, wo es geschrieben wird

- **Kommentare an einer Stelle.** Reviewer markieren einen Satz und kommentieren, du antwortest oder schliesst den Thread am selben Ort. Threads bleiben am Text haften, auch wenn er sich ändert.
- **Live bearbeiten.** Mehrere Autorinnen und Autoren schreiben gleichzeitig und sehen die Cursor der anderen.
- **Verlauf.** Das Aktivitätsprotokoll zeigt, wer was wann geändert hat, und jeder frühere Stand lässt sich wiederherstellen.
- **Code und Diagramme.** Codeblöcke mit Syntaxhervorhebung, und Mermaid für Flussdiagramme, Sequenzdiagramme und mehr, direkt auf der Seite gezeichnet.
- **PDF.** Exportiere ein seitenweises PDF für die Review-Sitzung oder das Archiv.

## Fragen

::faq{json-ld}
---
items:
  - q: Können Reviewer einzelne Sätze kommentieren?
    a: Ja. Wer Bearbeitungsrechte hat, kann eine Stelle markieren und kommentieren, antworten und Threads abschliessen. Die Kommentare bleiben am Text haften, wenn sich das Dokument ändert.
  - q: Kann ich Diagramme zeichnen?
    a: Ja, mit Mermaid in einem Codeblock: Flussdiagramme, Sequenzdiagramme, Zustandsdiagramme, Gantt-Diagramme und mehr werden auf der Seite gezeichnet, in der Vorschau und im PDF.
  - q: Wird es mit Git oder GitHub synchronisiert?
    a: Nein. Das Dokument lebt in markoto. Du kannst es als Markdown-Datei herunterladen und diese einchecken.
  - q: Kann ich Entscheide festhalten?
    a: Der Abschnitt Entscheide und der Statuskopf sind Teil des Dokuments, und das Aktivitätsprotokoll hält jede Änderung fest. Setze den Status auf Angenommen, wenn der Entscheid gefallen ist, und behalte das Dokument als Nachweis.
---
::

::cta{title="Schlag die Änderung vor, in einem Dokument, das man prüfen kann." label="Diese Vorlage verwenden" template="design-doc"}
Kostenlos auf markoto.app, ohne Registrierung.
::
