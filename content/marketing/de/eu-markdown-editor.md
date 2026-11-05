---
title: Ein Markdown-Editor, gehostet in der EU
description: markoto.app speichert Dokumente in Frankreich, nutzt KI-Anbieter in der EU und nur notwendige Cookies. Wer es betreibt, welche Anbieter, DSGVO, Self-Hosting.
keywords:
  - markdown editor dsgvo
  - dsgvo konformer editor
  - markdown editor eu hosting
  - markdown editor europa
  - google docs alternative dsgvo
# Menu label once reviewed (group + order come from the English page).
navLabel: "Gehostet in der EU"
updated: '2026-11-04'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). See docs/TRANSLATION-REVIEW.md.
# Legal facts follow content/legal/privacy/de.md (version 8).
reviewed: false
---

# Ein Markdown-Editor, gehostet in der EU

markoto ist ein kollaborativer Markdown-Editor, betrieben von einem Schweizer Unternehmen. Auf markoto.app liegen Ihre Dokumente, Bilder und Sicherungskopien in der EU (Frankreich), und die KI-Funktionen nutzen Anbieter in der EU. Diese Seite zeigt, wohin Daten gehen und was wir nicht behaupten, damit Sie es mit Ihren eigenen Anforderungen abgleichen können. Verbindlich ist die [Datenschutzerklärung](/legal/privacy); wo diese Seite und die Erklärung voneinander abweichen, gilt die Erklärung.

## Wer markoto betreibt

markoto.app wird von der **LatentSpace Labs GmbH** in Zürich (Schweiz) betrieben. Die Datenschutzerklärung ist sowohl auf das Schweizer Datenschutzgesetz (DSG) als auch auf die Datenschutz-Grundverordnung der EU (DSGVO) ausgerichtet. Der Bundesrat anerkennt für die Staaten der EU und des EWR einen angemessenen Datenschutz, und die Europäische Kommission anerkennt die Schweiz als angemessen. Daten können deshalb ohne weitere Garantien zwischen beiden fliessen.

## Wo Ihre Daten liegen

- **Dokumente, Kommentare, Verlauf und Kontodaten**: in der verwalteten PostgreSQL-Datenbank von OVHcloud in Frankreich.
- **Bilder und die täglichen Datenbank-Sicherungskopien**: im Object Storage von OVHcloud in Frankreich. Die Sicherungskopien sind verschlüsselt und werden etwa 30 Tage aufbewahrt.
- **Dateien der Wissensdatenbank**, die Sie in einen Workspace hochladen: Sie werden auf unseren eigenen Servern in Text umgewandelt, danach wird die Originaldatei gelöscht. Erhalten bleiben nur der Text und sein Suchindex.

## Wer sonst Daten erhält

Diese Dienstleister (Unterauftragsverarbeiter) nutzt markoto.app derzeit, aus demselben Verzeichnis wie die [Seite der Unterauftragsverarbeiter](/legal/sub-processors):

::sub-processors
::

Kurz gesagt: Speicher und alle KI-Anbieter befinden sich in der EU. Anbieter mit Sitz in den USA übernehmen nur eng begrenzte Aufgaben:

- **Google und GitHub** nur, wenn Sie die Anmeldung über diese Dienste wählen. markoto liest dort Ihren Namen, Ihre bestätigte E-Mail-Adresse und Ihre Konto-ID, sonst nichts.
- **Resend** stellt die wenigen E-Mails zu, die markoto verschickt (zum Beispiel Einladungen und Bestätigungen einer Kontolöschung).
- **Sentry** erhält Fehlerberichte. Sie werden in der EU-Region von Sentry (Frankfurt) gespeichert; das US-Unternehmen kann für Support und Betrieb Zugriff haben.

Diese Übermittlungen stützen sich auf das EU-U.S. und das Swiss-U.S. Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung, wie in der Datenschutzerklärung beschrieben.

## KI-Funktionen

Schreibassistent, Spracheingabe, Websuche, Seitenabruf und Bilderzeugung laufen über das eigene KI-Gateway von markoto zu Anbietern in der EU: Mistral AI (Frankreich; Rechenzentren in der EU und der EFTA) für Text und Sprache, Jina AI (Deutschland) für die Suche in der Wissensdatenbank und das Lesen von Webseiten, Staan (Frankreich) für die Websuche und Black Forest Labs für Bilder (auf eine EU-Region festgelegt).

- **Ohne KI-Nutzung geht nichts an einen KI-Anbieter.** Dokumentinhalte werden nur gesendet, wenn Sie den Assistenten nutzen oder Dateien in die Wissensdatenbank eines Workspace hochladen. KI setzt ein Konto voraus; anonyme Besucherinnen und Besucher können sie nicht nutzen.
- **Kein Training mit Ihren Inhalten.** markoto trainiert keine Modelle. Jina AI und Staan erklären, dass sie Anfragedaten nicht zum Training verwenden; bei Mistral AI und Black Forest Labs hat markoto dem Training widersprochen (Opt-out).
- **Ihr eigener Anbieter ist Ihre Wahl.** Binden Sie unter Einstellungen › KI-Anbieter einen eigenen KI-Anbieter an, gehen Ihre KI-Anfragen an diesen Anbieter, auf Grundlage Ihrer eigenen Vereinbarung mit ihm. Er ist dann nicht Unterauftragsverarbeiter von markoto, und wo er Daten verarbeitet, hängt vom gewählten Anbieter ab.
- **KI-Eingaben und Werkzeugaufrufe** werden 90 Tage lang zur Missbrauchsprüfung aufbewahrt und dann gelöscht.

::flow-strip{id="use-your-own-ai-provider" frames="06" caption="Einstellungen › KI-Anbieter: der Schreibassistent, verbunden mit einem selbst gewählten Anbieter."}
::

## Kein Tracking

markoto.app verwendet nur Speicher, der für den Betrieb unbedingt erforderlich ist: die Anmeldesitzung, Ihre Sprache und einige Schlüssel für anonyme Dokumente. Es gibt keine Analyse, keine Sitzungsaufzeichnung, keine Werbung und kein seitenübergreifendes Tracking, deshalb auch kein Cookie-Banner. Die Datenschutzerklärung listet jedes Cookie und jeden Speicherschlüssel auf.

Dokumente werden von Suchmaschinen nicht indexiert: Jede Dokumentseite sendet eine `noindex`-Anweisung. Ein Link kann trotzdem weitergegeben werden; behandeln Sie einen geteilten Link deshalb als öffentlich.

## Für Schulen, Teams und Unternehmen

- **Auftragsverarbeitungsvertrag.** Wenn Sie einen Workspace erstellen, handelt markoto für die Inhalte, die Ihr Team dort einbringt, als Ihr Auftragsverarbeiter, auf Grundlage des [Auftragsverarbeitungsvertrags](/legal/dpa). Sie akzeptieren ihn, wenn Sie Ihren ersten Workspace erstellen.
- **Export.** Alle Nutzerinnen und Nutzer können in ihrem Profil ein ZIP mit allem herunterladen, was markoto über sie speichert (Dokumente als Markdown, Kommentare, Einstellungen, Protokolle).
- **Löschung.** Die Löschung eines Kontos wird nach einer Karenzzeit von 30 Tagen wirksam, die Sie abbrechen können. Danach werden Dokumente, Workspaces, in denen Sie das einzige Mitglied sind, und KI-Daten gelöscht, und Ihre Kommentare in Dokumenten anderer werden anonymisiert.
- **Neue Unterauftragsverarbeiter** kündigen wir Workspace-Eigentümerinnen und -Eigentümern mindestens 30 Tage im Voraus an.

::flow-strip{id="data-export" frames="06" caption="Der Datenexport auf der Profilseite: Das Archiv steht zum Herunterladen bereit."}
::

## Was markoto nicht behauptet

- **Keine Zertifizierung.** Ein «DSGVO-Zertifikat» für ein Produkt gibt es nicht, und markoto hat keine eigene Sicherheitszertifizierung (kein ISO 27001, kein SOC 2). Der Speicheranbieter veröffentlicht seine eigenen Zertifizierungen.
- **Keine Ende-zu-Ende-Verschlüsselung.** Die Server von markoto können Ihre Dokumente lesen; das müssen sie, um Seiten darzustellen, PDFs zu erzeugen und die KI auszuführen. Daten sind bei der Übertragung und im Ruhezustand verschlüsselt. Darf der Server Ihre Inhalte nicht lesen können, verwenden Sie stattdessen ein Ende-zu-Ende-verschlüsseltes Werkzeug.
- **Keine Rechtsberatung.** Ob markoto die Pflichten Ihrer Organisation erfüllt, entscheiden Sie oder Ihre Datenschutzbeauftragten. Datenschutzerklärung, Auftragsverarbeitungsvertrag und die Liste der Unterauftragsverarbeiter sollen diese Prüfung möglich machen.

## Volle Kontrolle: selbst betreiben

Dürfen Ihre Daten Ihre eigene Infrastruktur nicht verlassen, [hosten Sie markoto selbst](/self-hosted-markdown-editor) (auf Englisch). Eine selbst gehostete Instanz verwendet denselben Code wie markoto.app und läuft mit Docker Compose auf Ihrem eigenen Server, mit Anmeldung über Ihren eigenen Identity Provider (OpenID Connect) und KI nur bei Anbietern, die Sie einrichten, lokale Modelle eingeschlossen. Vorschau und PDF-Export laden nichts von Dritten, eine Instanz funktioniert also auch in einem abgeschotteten Netz. Auf Ihrer eigenen Instanz sind Sie Betreiber und Verantwortlicher; die Anbieter von markoto.app sind nicht beteiligt.

## Fragen

::faq{json-ld}
---
items:
  - q: Wo werden meine Dokumente gespeichert?
    a: Auf markoto.app bei OVHcloud in Frankreich, in einer verwalteten PostgreSQL-Datenbank. Bilder und die verschlüsselten täglichen Sicherungskopien liegen im Object Storage von OVHcloud, ebenfalls in Frankreich.
  - q: Ist markoto DSGVO-konform?
    a: markoto.app wird so betrieben, dass es die DSGVO und das Schweizer DSG erfüllt, und die Datenschutzerklärung erklärt, wie. Eine offizielle DSGVO-Zertifizierung für Produkte gibt es nicht, deshalb behauptet markoto keine. Gleichen Sie Datenschutzerklärung, Auftragsverarbeitungsvertrag und die Liste der Unterauftragsverarbeiter mit Ihren eigenen Anforderungen ab.
  - q: Erhalten US-Unternehmen meine Dokumente?
    a: Nein. Dokumente werden in der EU gespeichert, und die KI-Anbieter sitzen in der EU. Anbieter aus den USA übernehmen die Anmeldung über Google oder GitHub (falls Sie diese wählen), Transaktions-E-Mails und Fehlerberichte.
  - q: Verwendet markoto meine Dokumente zum Training von KI?
    a: Nein. markoto trainiert keine Modelle und hat bei den KI-Anbietern, die das Training vorsehen, widersprochen.
  - q: Gibt es einen Auftragsverarbeitungsvertrag?
    a: Ja, für Workspace-Eigentümerinnen und -Eigentümer. markoto handelt für die Inhalte in Ihrem Workspace als Auftragsverarbeiter auf Grundlage seines Auftragsverarbeitungsvertrags, den Sie beim Erstellen eines Workspace akzeptieren.
  - q: Ist markoto Ende-zu-Ende-verschlüsselt?
    a: Nein. Der Server muss Dokumente lesen, um Seiten und PDFs darzustellen. Daten sind bei der Übertragung und im Ruhezustand verschlüsselt.
  - q: Kann ich markoto selbst hosten?
    a: Ja. Der Quellcode von markoto ist einsehbar (source-available), und markoto lässt sich mit Docker Compose auf Ihrem eigenen Linux-Server installieren. Dann gehen überhaupt keine Daten an markoto.app.
---
::

::cta{title="Schreiben Sie in einem Editor, gehostet in der EU." secondary-label="Datenschutzerklärung lesen" secondary-to="/legal/privacy"}
Kostenlos auf markoto.app. Um ein Dokument anzulegen, brauchen Sie keine Registrierung.
::
