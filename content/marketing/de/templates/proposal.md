---
title: Angebot Vorlage in Markdown mit PDF
description: Angebot Vorlage in Markdown mit Deckblatt, Zusammenfassung, Vorgehen in Phasen, Zeitplan, Preistabelle, Bedingungen und Unterschriftenfeld, als PDF.
keywords:
  - angebot vorlage
  - angebot erstellen
  - offerte vorlage
  - angebot vorlage markdown
  - offerte pdf vorlage
# Menu label once reviewed (group + order come from the English page).
navLabel: "Angebot Vorlage"
updated: '2026-11-19'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# Angebot Vorlage in Markdown

Ein Angebot muss die Fragen eines Einkaufsteams in fester Reihenfolge beantworten: für wen ist es, was ist das Problem, was wirst du tun, wann, für wie viel, zu welchen Bedingungen. Diese Vorlage hat für jede Frage einen Abschnitt, dazu ein Deckblatt, eine Preistabelle, die wie eine Rechnung aussieht, und ein Unterschriftenfeld zum Ausdrucken oder Unterschreiben.

Unten siehst du den Anfang eines Angebots für einen erfundenen Kunden, im Design **Angebot**.

::try-it{theme="proposal" height="760"}
---
source: |
  # Website-Relaunch für Harbourline

  | | |
  |---|---|
  | **Erstellt für** | Harbourline AG, Mara Keller |
  | **Erstellt von** | Northlight Studio, Sam Weber |
  | **Datum** | 2026-11-19 |
  | **Gültig bis** | 2026-12-31 |

  # Zusammenfassung

  Die Website von Harbourline verliert Besucher auf dem Handy und braucht eine Woche für jede Aktualisierung. Wir schlagen vor, sie in **10 Wochen** für **CHF 38'400** neu aufzubauen, damit euer Team Änderungen am selben Tag veröffentlichen kann.

  # Unser Vorgehen

  ## Phase 1: Inhalt und Struktur (Wochen 1-3)

  - Bestandsaufnahme jeder Seite und ihres Verkehrs.
  - Neue Sitemap, mit euch abgestimmt.

  ## Phase 2: Umsetzung (Wochen 4-10)

  - Vorlagen, Migration und Livegang.

  # Investition

  | Position | Tage | Ansatz | Betrag |
  |---|---:|---:|---:|
  | Inhalt und Struktur | 12 | 1'200 | 14'400 |
  | Umsetzung | 20 | 1'200 | 24'000 |
  | **Total (CHF)** | | | **38'400** |

  # Annahme

  Mit der Unterschrift akzeptieren beide Parteien dieses Angebot und seine Bedingungen.

  | Harbourline AG | Northlight Studio |
  |---|---|
  | | |
  | Ort, Datum | Ort, Datum |
---
::

::page-shots{caption="Die erste Seite der Angebot-Vorlage: das Deckblatt mit Titel, Kunde und deiner Firma."}
---
pages:
  - src: /template-thumbs/proposal.webp
    alt: Deckblatt der Angebot-Vorlage mit einem Titel, dem Namen des Kunden und der Firma der Verfasserin oder des Verfassers.
---
::

::cta{title="Starte dein Angebot mit dieser Vorlage." label="Diese Vorlage verwenden" template="proposal" secondary-label="Alle Vorlagen" secondary-to="/templates"}
Öffnet den Dialog für neue Dokumente mit ausgewählter Angebot-Vorlage: Text und Design Angebot in einem. Jeder Abschnitt beginnt mit einem kurzen Hinweis.
::

## Was drin ist

- **Deckblatt und Eckdaten.** Der Titel, „Erstellt für ...“ und deine Firma auf dem Deckblatt, dazu eine Tabelle mit Kunde, Verfasser, Referenz, Datum und Gültigkeit.
- **Zusammenfassung.** Eine halbe Seite für die Entscheiderin oder den Entscheider: das Problem, dein Vorschlag, die Dauer und der Preis.
- **Eure Situation und Ziele.** Die Probleme des Kunden in seinen Worten, dann drei bis fünf Ergebnisse, die sich am Ende prüfen lassen.
- **Vorgehen, Zeitplan und Investition.** Ein Abschnitt pro Phase mit ihren Lieferergebnissen, eine Tabelle mit Terminen und eine Preistabelle mit rechtsbündigen Beträgen, einer Zwischensumme und einem unterstrichenen Total. Optionale Positionen bekommen eine eigene Tabelle, damit der Hauptpreis vergleichbar bleibt.
- **Bedingungen und Annahme.** Nummerierte Klauseln und ein Unterschriftenfeld mit einer Linie für jede Seite.

Die Hinweise unter den Überschriften sind Markdown-Kommentare: im Editor und für den KI-Assistenten sichtbar, nie auf der Seite oder im PDF.

## Von der Vorlage zum Angebot eines Teams

Schreibe ein Angebot einmal und verwende es wieder. Mit einem Konto kannst du ein fertiges Angebot als Start für das nächste duplizieren. Wenn bei einem Team alle Angebote gleich aussehen müssen, kann ein Workspace ein Angebot als Vorlage bereithalten, die Mitglieder kopieren, und das Design des Workspace sperren; siehe [Angebote für Beratungen und Agenturen](/de/proposal-software-for-consultants).

## Was es nicht kann

markoto hat keine elektronische Signatur und keine Zahlung: Das Unterschriftenfeld ist zum Ausdrucken oder Unterschreiben auf einer Kopie da. Preise tippst du in eine Tabelle; Summen rechnet sie nicht aus. Prüfe die Beträge, bevor du das Angebot abschickst.

## Fragen

::faq{json-ld}
---
items:
  - q: Berechnet die Preistabelle das Total?
    a: Nein. Tabellen sind einfaches Markdown, du tippst die Beträge und das Total selbst. Das Design formatiert sie wie eine Rechnung, mit einem unterstrichenen Total.
  - q: Kann der Kunde in markoto unterschreiben?
    a: Nein. markoto hat keine elektronische Signatur. Exportiere das PDF und unterschreibe es auf Papier oder mit einem Signaturwerkzeug, das du schon nutzt.
  - q: Kann ich mein Logo einfügen?
    a: Ja, mit einem Konto, denn ein Logo ist ein Upload. Das Deckblatt und die Kopfzeile haben dafür einen Platz.
  - q: Kann ich dem Kunden einen Link statt eines PDFs schicken?
    a: Ja. Teile das Dokument nur zum Lesen oder veröffentliche es als Webseite. Ein Link lässt sich auch mit einem Passwort schützen, und wo dein Plan Link-Einstellungen enthält, kann er ein Ablaufdatum bekommen.
---
::

::cta{title="Ein Angebot, das aussieht, als hätte es deine Firma geschrieben." label="Diese Vorlage verwenden" template="proposal"}
Kostenlos auf markoto.app, ohne Registrierung.
::
