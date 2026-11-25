---
title: "KI-Agenten-Pläne prüfen mit Kommentaren"
description: Claude Code, Cursor oder ein MCP-Agent schreibt den Plan in markoto. Dein Team kommentiert die gerenderte Fassung, und der Agent liest die Kommentare zurück.
keywords:
  - ki-agenten plan prüfen
  - claude code plan reviewen
  - cursor plan review
  - mcp dokument review
  - ki spezifikation mit kommentaren prüfen
# Menu label once reviewed (group + order come from the English page).
navLabel: "Agenten-Pläne prüfen"
updated: '2026-11-25'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
reviewed: false
---

# KI-Agenten-Pläne und Spezifikationen mit dem Team prüfen

Ein Coding-Agent schreibt einen Plan, eine Spezifikation oder einen Entwurf in eine Markdown-Datei in deinem Repository. Dort liest ihn niemand sonst. markoto gibt dem Plan einen Ort, an dem Leute ihn lesen können: Der Agent schreibt ihn über MCP in ein Dokument, dein Team liest ihn als gerenderte Seite, kommentiert die Sätze, mit denen es nicht einverstanden ist, und der Agent liest diese Kommentare und überarbeitet den Plan.

## Der Ablauf

1. **Der Agent schreibt den Plan.** Über den MCP-Server legt er ein Dokument an, mit dem Markdown als Inhalt, und gibt dir den Link.
2. **Leute lesen die Seite.** Das Markdown erscheint als Seite mit Überschriften, Tabellen, Aufgabenlisten und Diagrammen, nicht als Quelltext. Öffne sie im Browser, ohne Installation.
3. **Leute kommentieren.** Markiere einen Satz, kommentiere, erwähne eine Kollegin oder einen Kollegen. Mehrere Prüfende tun das gleichzeitig; jeder Kommentar hängt an der Stelle, um die es geht.
4. **Der Agent liest die Kommentare.** Du sagst dem Agenten, er solle das Dokument prüfen; er liest jeden Thread mit dem Zeilenbereich, an dem er hängt, den Antworten und dem Status, ob er erledigt ist.
5. **Der Agent überarbeitet und antwortet.** Er schreibt die betroffenen Abschnitte um, antwortet im Thread und schliesst die erledigten. Du siehst seine Änderungen im offenen Dokument eintreffen, zugeschrieben deinem MCP-Client, und du kannst die frühere Fassung wiederherstellen.

::flow-strip{id="have-a-discussion" frames="07,11"}
---
captions:
  - Ein Kommentar an der Stelle, um die es geht.
  - Eine Antwort darunter, sofort sichtbar, sobald sie abgeschickt ist. In diesem Ablauf kann die Antwort von deinem Agenten kommen.
---
::

## Welche Werkzeuge der Agent nutzt

Der MCP-Server von markoto bietet für diesen Ablauf die folgenden Werkzeuge. Welche dein Client sieht, hängt von den Scopes des Tokens ab.

| Schritt | Werkzeug | Scope |
|---|---|---|
| Den Plan schreiben | `create_document` (mit dem Markdown als Starttext), `insert_markdown` | `documents:write` |
| Einen langen Plan lesen | `outline`, `read_section`, `view_document` | `documents:read` |
| Das Feedback lesen | `read_comments`: Thread-IDs, Zeilenbereich, Status erledigt, Texte und Antworten | `documents:read` |
| Überarbeiten | `replace_section`, `edit_lines`, `replace_text`, `move_section` | `documents:write` |
| Antworten | `reply_to_comment`, `resolve_comment`, `create_comment` | `documents:write` |
| Das Layout prüfen | `view_pages` (Bilder der gedruckten Seiten), `export_document_as_pdf` | `documents:read` |

`replace_section` berührt nur geänderte Wörter, sodass Kommentare an Text, den der Agent in Ruhe gelassen hat, an ihrem Platz bleiben, und es kann eine Änderung ablehnen, wenn sich der Abschnitt geändert hat, seit der Agent ihn gelesen hat.

## Deinen Agenten verbinden

In Claude Code genügt ein Befehl, mit einem persönlichen Zugriffstoken aus deinem Profilmenü unter **Integrationen (MCP)**:

```sh
claude mcp add --transport http markoto https://markoto.app/mcp --header "Authorization: Bearer <your-token>"
```

Cursor und andere Clients nehmen dieselbe URL und denselben Header. Die Seite zum [MCP-Server](/mcp-document-server) und die [MCP-Dokumentation](/docs/ai/mcp) (auf Englisch) haben die Details. Ein Token handelt als du und nie mehr: Es kann kein Dokument öffnen, das du nicht öffnen kannst.

## Was du vorher wissen solltest

- **Schreiben braucht Schreibzugriff.** Im kostenlosen Tarif von markoto.app ist der MCP-Server nur lesend (100 Werkzeugaufrufe pro Tag): Ein Agent kann ein Dokument und seine Kommentare lesen, aber weder den Plan anlegen noch antworten. Schreibzugriff über MCP gehört zu den Bezahltarifen (ab Pro). Auf einer selbst gehosteten Instanz funktioniert der ganze Ablauf heute, ohne Tageslimit.
- **Der Agent bekommt keine Benachrichtigung.** Der MCP-Server beantwortet Werkzeugaufrufe und schickt nichts von sich aus. Sag dem Agenten, er solle die Kommentare lesen, wenn die Prüfung fertig ist.
- **Prüfende brauchen Bearbeitungsrechte zum Kommentieren.** Teile das Dokument mit einem Workspace oder mit einem Link mit Bearbeitungsrechten. Ein Nur-Lesen-Link kann den Plan lesen, aber nicht kommentieren.
- **Das Modell des Agenten ist deines.** Er denkt in deinem MCP-Client, mit dessen eigenen Bestätigungseinstellungen. markoto verlangt nicht, dass du jeden Werkzeugaufruf bestätigst.
- **Alles wird festgehalten.** Der Tab Aktivität zeigt, was dein MCP-Client geändert hat, mit einem Diff und einer Schaltfläche Wiederherstellen.

## Warum ein Dokument und keine Datei

- **Eine prüfbare Seite.** Tabellen, Aufgabenlisten, Formeln und Mermaid-Diagramme werden gezeichnet; die Prüfung findet auf der Seite statt, nicht im rohen Markdown.
- **Kommentare an einem Satz.** Prüfende diskutieren eine bestimmte Zeile, und der Thread bleibt haften, wenn der Agent drumherum umschreibt.
- **Live.** Du siehst die Änderungen des Agenten, sobald sie eintreffen, wie die einer anderen Mitarbeitenden.
- **Verlauf.** Stelle den Plan so wieder her, wie er vor der Überarbeitung des Agenten war.
- **Ein PDF oder eine Webseite.** Exportiere den fertigen Plan als PDF oder veröffentliche ihn als nur lesbare Webseite.

Wenn du mit einer Struktur starten willst, hat die Vorlage **Designdokument / RFC** einen Statuskopf, Ziele, Alternativen, Entscheidungen und Risiken. Sag dem Agenten, er solle das Dokument daraus mit `create_document` und der ID der Vorlage anlegen. Mehr dazu in der [Vorlage Designdokument](/de/templates/design-doc).

## Was es nicht kann

- **Keine Git-Synchronisierung.** Der Plan lebt in markoto. Lade ihn als Markdown herunter und committe diese Datei, wenn er final ist.
- **Keine Freigaben.** Es gibt eine Statuszeile, die du im Dokument setzen kannst, aber keinen Freigabe-Workflow.
- **Kein Push an den Agenten.** Er liest Kommentare, wenn man ihn darum bittet.
- **Nur persönliche Zugriffstoken.** Es gibt keine Anmeldung per OAuth für MCP-Clients.

## Fragen

::faq{json-ld}
---
items:
  - q: Kann mein Agent die Kommentare lesen, die mein Team hinterlässt?
    a: Ja. Das Werkzeug read_comments liefert jeden Thread eines Dokuments mit seinem verankerten Zeilenbereich, dem Status erledigt, den Kommentartexten und den Antworten. Es braucht den Scope documents:read.
  - q: Kann der Agent auf einen Kommentar antworten und ihn schliessen?
    a: Ja, mit reply_to_comment und resolve_comment, die documents:write brauchen. Auf markoto.app hat der kostenlose Tarif nur lesendes MCP, Schreiben braucht also einen Bezahltarif (ab Pro) oder eine selbst gehostete Instanz.
  - q: Welche Agenten funktionieren?
    a: Jeder MCP-Client, der sich über HTTP mit einem Authorization-Header mit einem entfernten Server verbinden kann, zum Beispiel Claude Code, Claude Desktop und Cursor oder deine eigenen Skripte.
  - q: Wird der Agent benachrichtigt, wenn jemand kommentiert?
    a: Nein. Der Server beantwortet Werkzeugaufrufe und schickt keine Benachrichtigungen. Bitte den Agenten, die Kommentare zu lesen, wenn die Prüfung fertig ist.
  - q: Können Leute sehen, was der Agent geändert hat?
    a: Ja. Seine Änderungen erscheinen live für alle, die das Dokument offen haben, und der Tab Aktivität zeigt sie als von deinem MCP-Client gemacht, mit einem Diff und einer Schaltfläche Wiederherstellen.
  - q: Synchronisiert es sich mit einem Git-Repository?
    a: Nein. markoto hat keine Git-Integration. Lade den fertigen Plan als Markdown herunter und füge ihn selbst deinem Repository hinzu.
---
::

::cta{title="Gib deinem Agenten einen Ort zum Schreiben, den Leute prüfen können." secondary-label="MCP-Server für Dokumente" secondary-to="/mcp-document-server"}
Registriere dich, erstelle unter Integrationen ein Token und verbinde deinen Client. Auf einer selbst gehosteten Instanz funktioniert der ganze Ablauf heute.
::
