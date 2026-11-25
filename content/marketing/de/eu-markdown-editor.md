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
updated: '2026-11-17'
# Machine draft, not yet read by a native speaker: noindex, no hreflang,
# not in the sitemap (shared/seo/marketing.ts). Review status: the operator runbook, kept outside this repository.
# Legal facts follow content/legal/privacy/de.md (version 8).
reviewed: false
---

# Ein Markdown-Editor, gehostet in der EU

markoto ist ein kollaborativer Markdown-Editor, betrieben von einem Schweizer Unternehmen. Auf markoto.app liegen deine Dokumente, Bilder und Sicherungskopien in der EU (Frankreich), und die KI-Funktionen nutzen Anbieter in der EU. Diese Seite zeigt, wohin Daten gehen und was wir nicht behaupten, damit du es mit deinen eigenen Anforderungen abgleichen kannst. Verbindlich ist die [Datenschutzerklärung](/legal/privacy); wo diese Seite und die Erklärung voneinander abweichen, gilt die Erklärung.

## Wer markoto betreibt

markoto.app wird von der **LatentSpace Labs GmbH** in Zürich (Schweiz) betrieben. Die Datenschutzerklärung ist sowohl auf das Schweizer Datenschutzgesetz (DSG) als auch auf die Datenschutz-Grundverordnung der EU (DSGVO) ausgerichtet. Der Bundesrat anerkennt für die Staaten der EU und des EWR einen angemessenen Datenschutz, und die Europäische Kommission anerkennt die Schweiz als angemessen. Daten können deshalb ohne weitere Garantien zwischen beiden fliessen.

## Wo deine Daten liegen

- **Dokumente, Kommentare, Verlauf und Kontodaten**: in der verwalteten PostgreSQL-Datenbank von OVHcloud in Frankreich.
- **Bilder und die täglichen Datenbank-Sicherungskopien**: im Object Storage von OVHcloud in Frankreich. Die Sicherungskopien sind verschlüsselt und werden etwa 30 Tage aufbewahrt.
- **Dateien der Wissensdatenbank**, die du in einen Workspace hochladest: Sie werden auf unseren eigenen Servern in Text umgewandelt, danach wird die Originaldatei gelöscht. Erhalten bleiben nur der Text und sein Suchindex.

## Wer sonst Daten erhält

Diese Dienstleister (Unterauftragsverarbeiter) nutzt markoto.app derzeit, aus demselben Verzeichnis wie die [Seite der Unterauftragsverarbeiter](/legal/sub-processors):

::sub-processors
::

Kurz gesagt: Speicher und alle KI-Anbieter befinden sich in der EU. Anbieter mit Sitz in den USA übernehmen nur eng begrenzte Aufgaben:

- **Google und GitHub** nur, wenn du die Anmeldung über diese Dienste wählst. markoto liest dort deinen Namen, deine bestätigte E-Mail-Adresse und deine Konto-ID, sonst nichts.
- **Resend** stellt die wenigen E-Mails zu, die markoto verschickt (zum Beispiel Einladungen und Bestätigungen einer Kontolöschung).
- **Sentry** erhält Fehlerberichte. Sie werden in der EU-Region von Sentry (Frankfurt) gespeichert; das US-Unternehmen kann für Support und Betrieb Zugriff haben.

Diese Übermittlungen stützen sich auf das EU-U.S. und das Swiss-U.S. Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung, wie in der Datenschutzerklärung beschrieben.

## KI-Funktionen

Schreibassistent, Spracheingabe, Websuche, Seitenabruf und Bilderzeugung laufen über das eigene KI-Gateway von markoto zu Anbietern in der EU: Mistral AI (Frankreich; Rechenzentren in der EU und der EFTA) für Text, Sprache und die Suche in der Wissensdatenbank, Staan (Frankreich) für die Websuche und das Lesen von Webseiten und Black Forest Labs für Bilder (auf eine EU-Region festgelegt).

- **Ohne KI-Nutzung geht nichts an einen KI-Anbieter.** Dokumentinhalte werden nur gesendet, wenn du den Assistenten nutzen oder Dateien in die Wissensdatenbank eines Workspace hochladest. KI setzt ein Konto voraus; anonyme Besucherinnen und Besucher können sie nicht nutzen.
- **Kein Training mit deinen Inhalten.** markoto trainiert keine Modelle. Staan erklärt, dass es Anfragedaten nicht zum Training verwendet; bei Mistral AI und Black Forest Labs hat markoto dem Training widersprochen (Opt-out).
- **Dein eigener Anbieter ist deine Wahl.** Binde unter Einstellungen › KI-Anbieter einen eigenen KI-Anbieter an, gehen deine KI-Anfragen an diesen Anbieter, auf Grundlage deiner eigenen Vereinbarung mit ihm. Er ist dann nicht Unterauftragsverarbeiter von markoto, und wo er Daten verarbeitet, hängt vom gewählten Anbieter ab.
- **KI-Eingaben und Werkzeugaufrufe** werden 90 Tage lang zur Missbrauchsprüfung aufbewahrt und dann gelöscht.

::flow-strip{id="use-your-own-ai-provider" frames="06" caption="Einstellungen › KI-Anbieter: der Schreibassistent, verbunden mit einem selbst gewählten Anbieter."}
::

## Keine Tracking-Cookies

markoto.app verwendet nur Speicher, der für den Betrieb unbedingt erforderlich ist: die Anmeldesitzung, deine Sprache und einige Schlüssel für anonyme Dokumente. Besuche der öffentlichen Seiten wie dieser zählen wir mit einem Statistik-Tool, das wir selbst betreiben, ohne Cookies und ohne etwas auf deinem Gerät zu speichern; Dokumente werden nie gezählt. Es gibt keine Sitzungsaufzeichnung, keine Werbung und kein seitenübergreifendes Tracking, deshalb auch kein Cookie-Banner. Die Datenschutzerklärung listet jedes Cookie und jeden Speicherschlüssel auf und erklärt die Statistik.

Dokumente werden von Suchmaschinen nicht indexiert: Jede Dokumentseite sendet eine `noindex`-Anweisung. Ein Link kann trotzdem weitergegeben werden; behandele einen geteilten Link deshalb als öffentlich.

## Für Schulen, Teams und Unternehmen

- **Auftragsverarbeitungsvertrag.** Wenn du einen Workspace erstellst, handelt markoto für die Inhalte, die dein Team dort einbringt, als dein Auftragsverarbeiter, auf Grundlage des [Auftragsverarbeitungsvertrags](/legal/dpa). Du akzeptierst ihn, wenn du deinen ersten Workspace erstellst.
- **Export.** Alle Nutzerinnen und Nutzer können in ihrem Profil ein ZIP mit allem herunterladen, was markoto über sie speichert (Dokumente als Markdown, Kommentare, Einstellungen, Protokolle).
- **Löschung.** Die Löschung eines Kontos wird nach einer Karenzzeit von 30 Tagen wirksam, die du abbrechen kannst. Danach werden Dokumente, Workspaces, in denen du das einzige Mitglied bist, und KI-Daten gelöscht, und deine Kommentare in Dokumenten anderer werden anonymisiert.
- **Neue Unterauftragsverarbeiter** kündigen wir Workspace-Eigentümerinnen und -Eigentümern mindestens 30 Tage im Voraus an.

::flow-strip{id="data-export" frames="06" caption="Der Datenexport auf der Profilseite: Das Archiv steht zum Herunterladen bereit."}
::

## Was markoto nicht behauptet

- **Keine Zertifizierung.** Ein «DSGVO-Zertifikat» für ein Produkt gibt es nicht, und markoto hat keine eigene Sicherheitszertifizierung (kein ISO 27001, kein SOC 2). Der Speicheranbieter veröffentlicht seine eigenen Zertifizierungen.
- **Keine Ende-zu-Ende-Verschlüsselung.** Die Server von markoto können deine Dokumente lesen; das müssen sie, um Seiten darzustellen, PDFs zu erzeugen und die KI auszuführen. Daten sind bei der Übertragung und im Ruhezustand verschlüsselt. Darf der Server deine Inhalte nicht lesen können, verwende stattdessen ein Ende-zu-Ende-verschlüsseltes Werkzeug.
- **Keine Rechtsberatung.** Ob markoto die Pflichten deiner Organisation erfüllt, entscheidest du oder entscheiden deine Datenschutzbeauftragten. Datenschutzerklärung, Auftragsverarbeitungsvertrag und die Liste der Unterauftragsverarbeiter sollen diese Prüfung möglich machen.

## Volle Kontrolle: selbst betreiben

Dürfen deine Daten deine eigene Infrastruktur nicht verlassen, [hoste markoto selbst](/self-hosted-markdown-editor) (auf Englisch). Eine selbst gehostete Instanz verwendet denselben Code wie markoto.app und läuft mit Docker Compose auf deinem eigenen Server, mit Anmeldung über deinen eigenen Identity Provider (OpenID Connect) und KI nur bei Anbietern, die du einrichtest, lokale Modelle eingeschlossen. Vorschau und PDF-Export laden nichts von Dritten, eine Instanz funktioniert also auch in einem abgeschotteten Netz. Auf deiner eigenen Instanz bist du Betreiber und Verantwortlicher; die Anbieter von markoto.app sind nicht beteiligt.

## Fragen

::faq{json-ld}
---
items:
  - q: Wo werden meine Dokumente gespeichert?
    a: Auf markoto.app bei OVHcloud in Frankreich, in einer verwalteten PostgreSQL-Datenbank. Bilder und die verschlüsselten täglichen Sicherungskopien liegen im Object Storage von OVHcloud, ebenfalls in Frankreich.
  - q: Ist markoto DSGVO-konform?
    a: markoto.app wird so betrieben, dass es die DSGVO und das Schweizer DSG erfüllt, und die Datenschutzerklärung erklärt, wie. Eine offizielle DSGVO-Zertifizierung für Produkte gibt es nicht, deshalb behauptet markoto keine. Gleiche Datenschutzerklärung, Auftragsverarbeitungsvertrag und die Liste der Unterauftragsverarbeiter mit deinen eigenen Anforderungen ab.
  - q: Erhalten US-Unternehmen meine Dokumente?
    a: Nein. Dokumente werden in der EU gespeichert, und die KI-Anbieter sitzen in der EU. Anbieter aus den USA übernehmen die Anmeldung über Google oder GitHub (falls du diese wählst), Transaktions-E-Mails und Fehlerberichte.
  - q: Verwendet markoto meine Dokumente zum Training von KI?
    a: Nein. markoto trainiert keine Modelle und hat bei den KI-Anbietern, die das Training vorsehen, widersprochen.
  - q: Gibt es einen Auftragsverarbeitungsvertrag?
    a: Ja, für Workspace-Eigentümerinnen und -Eigentümer. markoto handelt für die Inhalte in deinem Workspace als Auftragsverarbeiter auf Grundlage seines Auftragsverarbeitungsvertrags, den du beim Erstellen eines Workspace akzeptierst.
  - q: Ist markoto Ende-zu-Ende-verschlüsselt?
    a: Nein. Der Server muss Dokumente lesen, um Seiten und PDFs darzustellen. Daten sind bei der Übertragung und im Ruhezustand verschlüsselt.
  - q: Kann ich markoto selbst hosten?
    a: Ja. Der Quellcode von markoto ist einsehbar (source-available), und markoto lässt dich mit Docker Compose auf deinem eigenen Linux-Server installieren. Dann gehen überhaupt keine Daten an markoto.app.
---
::

::cta{title="Schreibe in einem Editor, gehostet in der EU." secondary-label="Datenschutzerklärung lesen" secondary-to="/legal/privacy"}
Kostenlos auf markoto.app. Um ein Dokument anzulegen, brauchst du keine Registrierung.
::
