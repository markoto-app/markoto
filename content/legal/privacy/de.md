---
slug: privacy
locale: de
version: 8
effectiveDate: 2026-11-03
translationStatus: machine-translated
---

# Datenschutzerklärung

> **Kurz gesagt:** markoto speichert die Dokumente, die Sie schreiben, die Kommentare, die Sie hinterlassen, und das Minimum, das wir für den Betrieb Ihres Kontos benötigen. Der Dienst ist kostenlos; kostenpflichtige Pläne werden noch nicht angeboten. Die KI-Funktionen laufen bei Anbietern in der EU (Mistral AI für Text und Sprache, Jina AI für Embeddings und das Abrufen einzelner Seiten, Staan für die Websuche, Black Forest Labs für die Bilderzeugung), es sei denn, Sie binden Ihren eigenen KI-Anbieter an; dann gehen Ihre KI-Inhalte an den von Ihnen gewählten Anbieter. Wir verwenden nur notwendige Cookies: keine Analyse, kein Tracking, keine Werbung. Wir verkaufen Ihre Daten nicht und trainieren keine KI mit Ihren Inhalten. Sie können die über Sie gespeicherten Daten jederzeit in Ihren Einstellungen exportieren und Ihr Konto dort löschen.

**Inhalt:** 1. Wer wir sind · 2. Welche Daten wir verarbeiten und warum · 2b. Anonyme Dokumente, die Bot-Prüfung und Missbrauchsmeldungen · 3. Rechtsgrundlagen · 4. Empfänger und internationale Übermittlungen · 5. Speicherort und Aufbewahrung · 5b. Was bei der Löschung Ihres Kontos geschieht · 6. Ihre Rechte · 7. Automatisierte Entscheidungsfindung · 8. KI-Funktionen und Transparenz · 9. Cookies und ähnliche Technologien · 10. Altersvoraussetzung · 11. Recht auf Beschwerde · 12. Sicherheit · 13. Verzeichnis der Verarbeitungszwecke · 14. Änderungen dieser Erklärung

---

## 1. Wer wir sind

markoto wird von **{{controllerName}}** ({{controllerAddress}}) betrieben. Bei Datenschutzfragen schreiben Sie an **{{privacyContactEmail}}**.

Diese Erklärung ist so verfasst, dass sie sowohl das **Bundesgesetz über den Datenschutz** (revidiertes DSG, in Kraft seit 1. September 2023) als auch, soweit sie auf uns anwendbar ist, die **Datenschutz-Grundverordnung** der EU (Verordnung (EU) 2016/679, «DSGVO») erfüllt. Die DSGVO gilt für uns, weil wir markoto Personen in der EU und im EWR anbieten.

Wir sind **Verantwortliche** für die Personendaten, die Sie uns direkt mitteilen: Ihr Konto, anonyme Dokumente, die Sie erstellen, Missbrauchsmeldungen und, falls Sie sich eintragen, die Warteliste für kostenpflichtige Pläne. Wenn Sie markoto in einem Workspace nutzen, der einer anderen Partei gehört, ist deren Eigentümerin bzw. Eigentümer Verantwortliche für die Inhalte, die in diesen Workspace eingebracht werden, und wir handeln als deren **Auftragsverarbeiter** auf Grundlage unseres Auftragsverarbeitungsvertrags (`/legal/dpa`).

## 2. Welche Daten wir verarbeiten und warum

Wir erheben nur, was der jeweilige Zweck erfordert, und sagen Ihnen, was der jeweilige Zweck ist. Die vollständige Liste der Verarbeitungszwecke mit Rechtsgrundlage, Datenkategorien, Aufbewahrungsdauer und Empfängern ist das Verzeichnis in §13, das aus unserem internen Register erzeugt wird. Jede Änderung dieses Verzeichnisses gilt als wesentliche Änderung dieser Erklärung und ändert ihre Version (siehe §14).

Kurz zusammengefasst verarbeiten wir:

- **Kontodaten:** Name, E-Mail-Adresse, die Kennung und das Profilbild Ihres Anmeldeanbieters (GitHub oder Google), Sprache, Altersbestätigung und welche Versionen unserer Richtlinien Sie akzeptiert haben.
- **Inhalte:** Dokumente, Kommentare, Bilder, Dateien der Wissensdatenbank, Themes und wer was bearbeitet hat.
- **KI-Nutzung:** Eingaben, Dokumentkontext und KI-Ergebnisse, wenn Sie die KI-Funktionen nutzen.
- **Technische Daten:** IP-Adressen (kurzzeitig für Ratenbegrenzungen verwendet und in Protokollen nur gekürzt gespeichert), Browsertyp, Fehlerberichte.

## 2b. Anonyme Dokumente, die Bot-Prüfung und Missbrauchsmeldungen

**Anonyme Dokumente.** Sie können ein Dokument ohne Konto erstellen. Bevor Ihr Browser das erste erstellt, setzen Sie ein Häkchen, um unsere Nutzungsbedingungen zu akzeptieren und zu bestätigen, dass Sie mindestens 16 Jahre alt sind, und Ihr Browser löst eine Bot-Prüfung. Wir speichern mit dem Dokument die Version der Nutzungsbedingungen, die Sie akzeptiert haben, und den Zeitpunkt sowie einen Hash eines zufälligen Ersteller-Schlüssels, den Ihr Browser in einem Cookie aufbewahrt, damit nur er das Dokument löschen kann. Ihr Browser merkt sich Ihre Zustimmung zudem in einem Cookie, sodass Sie erst wieder gefragt werden, wenn sich die Nutzungsbedingungen ändern (siehe §9). Wir fragen weder nach Ihrem Namen noch nach Ihrer E-Mail-Adresse. Jede Person mit dem Link kann das Dokument öffnen; geben Sie keine Personendaten anderer Personen darin ein. Ohne Konto erstellte Dokumente sind als Inhalte von Nutzenden gekennzeichnet, mit einem Link, um sie zu melden. Anonyme Dokumente werden nach **30 Tagen** ohne Aktivität automatisch gelöscht, zusammen mit der bei ihnen gespeicherten Zustimmung zu den Nutzungsbedingungen.

**Suchmaschinen.** Jede Dokumentseite, mit oder ohne Konto, weist Suchmaschinen an, sie nicht zu indexieren (ein Header `X-Robots-Tag: noindex` und ein entsprechendes Meta-Tag). Unsere `robots.txt` sperrt Dokumente bewusst nicht, denn eine Suchmaschine muss eine Seite abrufen können, um diese Anweisung zu sehen. Ein Link zu einem Dokument kann trotzdem weitergegeben werden; behandeln Sie einen geteilten Link deshalb als öffentlich.

**Bot-Prüfung.** Die Bot-Prüfung ist ein Proof-of-Work-Rätsel (ALTCHA), das unser eigener Server ausgibt und Ihr Browser löst. Sie bezieht keine Dritten ein und setzt kein Cookie. Wir prüfen die Lösung und bewahren einen Fingerabdruck des verwendeten Rätsels etwa 20 Minuten lang auf, damit es nicht erneut verwendet werden kann. Um massenhaftes Erstellen zu verhindern, zählen wir anonyme Anfragen pro IP-Adresse (bei IPv6 pro /64-Netz) in einem kurzlebigen Speicher; diese Zähler enthalten keine Inhalte und verfallen innerhalb eines Tages.

**Missbrauchsmeldungen.** Jede Person kann Inhalte melden, auch ohne Konto (dann geschützt durch dieselbe Bot-Prüfung). Wir speichern die Adresse des gemeldeten Inhalts, Ihre Erläuterung, die Kategorie, Ihren Namen und Ihre E-Mail-Adresse (freiwillig nur bei Meldungen von Darstellungen sexuellen Kindesmissbrauchs), die von Ihnen verwendete Sprache, wann Sie bestätigt haben, dass Sie die Meldung in gutem Glauben einreichen, den Zeitpunkt, eine gekürzte IP-Adresse und einen Hash des User-Agents Ihres Browsers (gegen massenhafte Meldungen) sowie Ihr Konto, falls Sie angemeldet waren. Wir verwenden dies, um Ihre Meldung zu bearbeiten, Ihnen den Eingang zu bestätigen und unseren Entscheid per E-Mail mitzuteilen und, wo das Gesetz es verlangt, Behörden zu informieren. Wenn wir ein Dokument entfernen oder einschränken, senden wir der Eigentümerin oder dem Eigentümer eine Begründung per E-Mail; darin werden Sie nicht genannt. Bei einem ohne Konto erstellten Dokument können wir die Person, die es erstellt hat, nicht erreichen und halten die Begründung als nicht zustellbar fest. Von jeder Mitteilung, die wir senden oder nicht zustellen konnten, bewahren wir eine Kopie bei der Meldung auf. Wir bewahren eine Meldung auf, solange der Fall offen ist, und löschen sie zusammen mit diesen Mitteilungen **1 Jahr nach Abschluss des Falls** (wenn wir gehandelt oder entschieden haben, nichts zu unternehmen). Ihr Datenexport enthält die Meldungen, die Sie im angemeldeten Zustand eingereicht haben, mit den Ihnen gesendeten Mitteilungen sowie die Begründungen, die Sie als Eigentümerin oder Eigentümer eines Dokuments erhalten haben.

## 3. Rechtsgrundlagen

Nach der DSGVO stützt sich jede Verarbeitung auf eine der folgenden Rechtsgrundlagen (Art. 6 DSGVO). Nach dem DSG bearbeiten wir Personendaten im Einklang mit dessen Grundsätzen (Art. 6 DSG) und stützen uns, wo eine Rechtfertigung erforderlich ist, auf dieselben Gründe (Art. 31 DSG).

- **Vertrag** (Art. 6 Abs. 1 lit. b DSGVO): alles, was zur Erbringung des von Ihnen genutzten Dienstes erforderlich ist: Konten, Dokumente, Zusammenarbeit, KI-Unterstützung und, sobald kostenpflichtige Pläne angeboten werden, Abrechnung.
- **Rechtliche Verpflichtung** (Art. 6 Abs. 1 lit. c DSGVO): das Sicherheits-Audit-Protokoll, die Bearbeitung von Missbrauchsmeldungen und behördlichen Anordnungen (Digital Services Act der EU) und, sobald kostenpflichtige Pläne angeboten werden, die steuerrechtliche Aufbewahrung von Abrechnungsunterlagen.
- **Berechtigtes Interesse** (Art. 6 Abs. 1 lit. f DSGVO): einen sicheren und missbrauchsfreien Dienst zu gewährleisten (Ratenbegrenzungen, Bot-Prüfung und Akzeptieren der Nutzungsbedingungen bei ohne Konto erstellten Dokumenten, Fehlerüberwachung) sowie Workspace-Einladungen. Sie können der Verarbeitung auf dieser Grundlage widersprechen (siehe §6).
- **Einwilligung** (Art. 6 Abs. 1 lit. a DSGVO): nur für die Warteliste für kostenpflichtige Pläne (Sie kreuzen das Kästchen an und bestätigen die E-Mail, die wir Ihnen senden). Sie können die Einwilligung jederzeit über den Abmeldelink widerrufen.

## 4. Empfänger und internationale Übermittlungen

Wir setzen eine kleine Zahl von Dienstleistern («Unterauftragsverarbeiter») auf Grundlage schriftlicher Auftragsverarbeitungsverträge ein (Art. 28 DSGVO, Art. 9 DSG). Die aktuelle Liste finden Sie unter `/legal/sub-processors`. Sie zeigt nur die Anbieter, die diese Installation tatsächlich nutzt: Stripe (Zahlungen) erscheint erst, wenn kostenpflichtige Pläne aktiviert sind, und ein KI-Anbieter, den **Sie** selbst anbinden (siehe §8), ist nicht unser Unterauftragsverarbeiter und wird nicht aufgeführt.

**Wohin Ihre Daten gehen.** Wir haben unseren Sitz in der Schweiz. Unsere Datenbank, unser Dateispeicher, unsere Sicherungskopien und unsere KI-Anbieter befinden sich in der EU (Frankreich und Deutschland). Der Bundesrat anerkennt für die EU und den EWR einen angemessenen Datenschutz, und die Europäische Kommission anerkennt die Schweiz als angemessen; für diese Übermittlungen sind daher keine weiteren Garantien erforderlich.

Einige Anbieter haben ihren Sitz in den **Vereinigten Staaten**:

| Anbieter | Was sie erhalten | Garantie |
| --- | --- | --- |
| Google LLC | Anmeldung, nur wenn Sie «Mit Google anmelden» wählen | Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung |
| GitHub, Inc. | Anmeldung, nur wenn Sie «Mit GitHub anmelden» wählen | Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung |
| Resend, Inc. | Empfängeradresse und Inhalt der E-Mails, die wir Ihnen senden | Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung |
| Functional Software, Inc. (Sentry) | Fehlerberichte: technische Details, die betroffene Seite oder Anfrage, Ihre interne Benutzer-ID. Gespeichert in der EU-Region von Sentry (Frankfurt); das US-Unternehmen kann für Support und Betrieb Zugriff haben | Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung |
| Stripe, Inc. | Abrechnungsdaten, erst wenn kostenpflichtige Pläne angeboten werden (derzeit nicht im Einsatz) | Data Privacy Framework, mit Standardvertragsklauseln als Rückfalllösung |

Für diese Übermittlungen stützen wir uns bei zertifizierten Empfängern auf das **EU-U.S. Data Privacy Framework** (Angemessenheitsbeschluss der Europäischen Kommission vom 10. Juli 2023) und das **Swiss-U.S. Data Privacy Framework** (vom Bundesrat mit Wirkung ab 15. September 2024 anerkannt), andernfalls auf die **Standardvertragsklauseln** der Europäischen Kommission (2021/914), angepasst an das Schweizer Recht, wie es der EDÖB verlangt.

Workspace-Eigentümerinnen und -Eigentümer informieren wir mindestens 30 Tage im Voraus über jeden neuen Unterauftragsverarbeiter.

## 5. Speicherort und Aufbewahrung

Anwendungsdaten und Dokumente liegen in der verwalteten PostgreSQL-Datenbank und im Object Storage von OVHcloud in der EU (Frankreich). Die KI-Verarbeitung erfolgt durch Anbieter in der EU: Mistral AI (Frankreich), Jina AI (Deutschland), Staan (Frankreich) und Black Forest Labs (auf eine EU-Region festgelegt), geleitet über unseren eigenen LiteLLM-Proxy. Solange der Dienst kostenlos ist, verarbeiten wir keine Zahlungsdaten. Fehlerberichte werden von Sentry in dessen EU-Region (Frankfurt) verarbeitet. Transaktions-E-Mails werden über Resend versandt.

Die Aufbewahrung richtet sich nach dem Verzeichnis in §13. Allgemein gilt:

- **Kontodaten** bleiben bestehen, bis Sie Ihr Konto löschen.
- **Dokumente und Inhalte** bleiben bestehen, bis Sie sie oder Ihr Konto löschen.
- **Anonyme Dokumente** (ohne Anmeldung erstellt und nicht Teil eines Workspace) werden nach **30 Tagen** ohne Aktivität automatisch gelöscht. Dokumente, die einem Konto gehören, und Workspace-Dokumente werden nicht automatisch gelöscht.
- **KI-Eingabe- und Werkzeugaufruf-Protokolle** werden 90 Tage lang zur Missbrauchsprüfung aufbewahrt und dann gelöscht.
- **KI-Nutzungsdaten** (zu jeder KI-Anfrage, die wir bezahlen: Kosten, Modell, Zeitpunkt und Ihre interne Nutzer-ID) bewahrt unser LiteLLM-Proxy 90 Tage lang auf, Ihre Monatssummen bis zur monatlichen Rücksetzung des Kontingents. Wir verwenden sie, um das Limit pro Konto und den gemeinsamen Monatstopf durchzusetzen. Anfragen an Ihren eigenen Anbieter werden ebenfalls erfasst, mit Kosten null, um Ratenlimiten anzuwenden.
- **Audit-Protokoll.** Unser Sicherheits-Audit-Protokoll hält fest, wer Zugriffskontrollen geändert, Inhalte gelöscht oder andere sicherheitsrelevante Aktionen ausgeführt hat, mit gekürzten IP-Adressen (IPv4 auf /24, IPv6 auf /48). Einträge werden nach **2 Jahren** automatisch gelöscht. Löschen Sie Ihr Konto früher, wird Ihre Konto-ID sofort daraus entfernt.
- **Sicherungskopien.** Wir erstellen einmal täglich eine verschlüsselte Sicherungskopie der Datenbank und bewahren die letzten 30 auf, sodass jede Sicherungskopie etwa **30 Tage** lang aufbewahrt wird. Daten, die Sie löschen, bleiben daher bis zu 30 Tage in unseren Sicherungskopien, bevor sie überschrieben werden. Unser Datenbankanbieter OVHcloud bewahrt zudem für eine begrenzte Zeit eigene automatische Sicherungskopien auf. Wir verwenden Sicherungskopien nur, um den Dienst nach einem Ausfall wiederherzustellen.
- **Abrechnungsunterlagen** gibt es nicht, solange der Dienst kostenlos ist. Sobald kostenpflichtige Pläne angeboten werden, werden sie für die steuerrechtlich vorgeschriebene Dauer aufbewahrt (in der Schweiz 10 Jahre).
- **Transaktions-E-Mails.** Resend bewahrt Zustellprotokolle (Empfänger, Zeitpunkt, Status) 30 Tage lang auf. Wir bewahren keine Kopien der E-Mails auf, die wir versenden.
- **Warteliste für kostenpflichtige Pläne.** Wenn Sie sich auf der Preisseite in die Warteliste eintragen, speichern wir Ihre E-Mail-Adresse, die Sprache bei der Anmeldung, welche Version des Einwilligungstextes Sie akzeptiert haben, den Zeitpunkt von Anmeldung und Bestätigung sowie, falls Sie angemeldet waren, eine Verknüpfung mit Ihrem Konto. Wir speichern Ihre IP-Adresse nicht. Wir verwenden dies ausschliesslich, um Sie zu informieren, wenn kostenpflichtige Pläne starten. Ihr Eintrag zählt erst, nachdem Sie den Bestätigungslink in unserer E-Mail angeklickt haben (Double-Opt-in); unbestätigte Einträge werden nach 7 Tagen gelöscht. Jede E-Mail enthält einen Abmeldelink, der Ihren Eintrag sofort löscht; andernfalls löschen wir die Liste spätestens 3 Monate nach Versand der Ankündigung des Starts. Die Löschung Ihres Kontos löscht auch einen verknüpften Eintrag, und Ihr Datenexport enthält ihn.
- **Workspace-Einladungen.** Lädt ein Admin eines Workspace jemanden per E-Mail ein, speichern wir die eingegebene Adresse, die angebotene Rolle und die einladende Person in einer offenen Einladung. Niemand wird ohne Annahme Mitglied. Die Einladung wird gelöscht, sobald sie angenommen, abgelehnt oder zurückgezogen wird, spätestens nach 14 Tagen. Ist E-Mail eingerichtet, wird eine Einladungs-E-Mail mit einem einmal verwendbaren Link über Resend versendet. Die Löschung Ihres Kontos löscht an Sie gerichtete Einladungen, und Ihr Datenexport listet die offenen Einladungen auf, die Sie erhalten und versendet haben.

## 5b. Was bei der Löschung Ihres Kontos geschieht

Die Schaltfläche unter `/settings/profile` plant die endgültige Löschung Ihres Kontos **in 30 Tagen** ein. Während dieser Karenzzeit bleibt Ihr Konto nutzbar, und Sie können auf jeder Seite, die das Löschbanner zeigt, abbrechen. Nach Ablauf der 30 Tage läuft Folgendes automatisch ab, ohne weitere Bestätigung und ohne Möglichkeit, etwas wiederherzustellen.

### Was endgültig gelöscht wird

- **Ihr Konto**: Name, E-Mail, Anmeldekennungen, Einstellungen, Sprache, Altersbestätigung, akzeptierte Versionen der Richtlinien.
- **Jedes Dokument, das Ihnen gehört**, einschliesslich Dokumenten, die Sie mit Mitwirkenden im Bearbeitungsmodus geteilt haben. Mitwirkende verlieren gleichzeitig den Zugriff. *Wenn Mitwirkende ein Dokument behalten sollen, übertragen Sie es ihnen oder duplizieren Sie es zuvor unter ihrem Konto.*
- **Jedes gespeicherte Theme** unter Ihrem Konto.
- **Jeder Workspace, in dem Sie das einzige Mitglied sind**, mit jedem Dokument und jeder Wissensdatei darin. *Um Workspace-Inhalte zu behalten, laden Sie vor der Löschung Ihres Kontos ein weiteres Mitglied ein oder laden Sie die Dokumente zuvor über den Datenexport unter `/settings/profile` herunter.*
- **Ihre KI-Nutzung**: frühere Eingaben (90 Tage lang zur Missbrauchsprüfung aufbewahrt), offene KI-Sitzungen sowie Einstellungen eines selbst angebundenen KI-Anbieters (Bring your own key) samt verschlüsselten API-Schlüsseln (siehe §8).
- **Ihre Datenexport-Aufträge** und alle für Sie vorbereiteten ZIP-Dateien.
- **Ihr Stripe-Kundendatensatz, sofern vorhanden** (erst möglich, wenn kostenpflichtige Pläne angeboten werden). Wir weisen Stripe an, ihn zu löschen; Stripe bewahrt Rechnungs- und Zahlungsunterlagen für die steuerrechtlich vorgeschriebene Dauer auf.

Gelöschte Daten bleiben in unseren verschlüsselten Datenbank-Sicherungskopien, bis diese überschrieben werden, längstens 30 Tage (siehe §5).

### Was anonymisiert wird: aufbewahrt, aber ohne Ihren Namen

- **Kommentare, die Sie zu Dokumenten verfasst haben, die Ihnen nicht gehören.** Der Text bleibt, damit die Unterhaltung für andere verständlich bleibt, aber Ihr Name und Ihre Kontoverknüpfung werden durch `[deleted user]` ersetzt.
- **Audit-Protokolleinträge.** Wir behalten den Eintrag im Sicherheitsprotokoll, entfernen aber Ihre Konto-ID. Diese Einträge werden nach 2 Jahren gelöscht (siehe §5).
- **Aktivitätsprotokolleinträge.** Ihre Bearbeitungen, Wiederherstellungen und Theme-Änderungen an Dokumenten, die Ihnen nicht gehören, bleiben im Aktivitätsverlauf des Dokuments unter «Anonym» bestehen. Einträge zu Ihren eigenen Dokumenten werden mit diesen gelöscht.
- **Einwilligungsnachweise.** Wir entfernen die Verknüpfung mit Ihrem Konto, behalten aber den Eintrag, damit wir nachweisen können, dass eine Einwilligung erteilt wurde (Art. 7 Abs. 1 DSGVO).

### Workspaces, in denen Sie gemeinsam mit anderen Admin sind

Sind Sie Admin eines Workspace mit mindestens einem weiteren Mitglied, **befördern wir automatisch eines der verbleibenden Mitglieder zum Admin**: das am längsten beteiligte Mitglied, wobei ein bestehender Admin, dann ein Editor, dann ein Betrachter bevorzugt wird. Der Workspace und seine Inhalte bleiben bei den verbleibenden Mitgliedern, und der neue Admin wird benachrichtigt. Das Feld «Eigentümer» des Workspace wird dem neuen Admin zugewiesen; der Zugriff richtete sich stets nach den Mitgliedsrollen, dies ist also reine Buchführung.

### Zuerst aufräumen

Die Löschung eines Workspace entfernt auch Inhalte, die andere Personen in einen Workspace eingebracht haben, in dem Sie das einzige Mitglied sind. Bevor Sie die Löschung beantragen:

- Für einen Workspace, den Sie behalten möchten: Laden Sie mindestens eine mitwirkende Person als Admin ein, damit sie ihn übernimmt.
- Für ein Dokument, das eine mitwirkende Person behalten soll: Verschieben Sie es in einen Workspace, der ihr gehört, duplizieren Sie es unter ihrem Konto oder lassen Sie sie eine Kopie herunterladen.
- Für Dateien der Wissensdatenbank, die Sie behalten möchten: Laden Sie sie herunter, da sie mit dem Workspace gelöscht werden.

### Ihr Datenexport

Vor der Löschung Ihres Kontos können Sie über den **Datenexport** unter `/settings/profile` ein ZIP-Archiv mit allem erhalten, was wir über Sie speichern: Dokumente als Markdown, Ihre Kommentare, Workspace-Mitgliedschaften, KI-Nutzungsprotokolle, Ihre KI-Anbietereinstellungen (URL, Modell und Funktion, nie der API-Schlüssel), Ihren Wartelisteneintrag, Einwilligungsnachweise und, sobald es kostenpflichtige Pläne gibt, den Abrechnungsverlauf.

### Wie lange es dauert

Ein Hintergrundjob läuft einmal pro Stunde, sodass Ihre Daten etwa eine Stunde nach Ablauf der Karenzzeit gelöscht sind. Sie erhalten eine Bestätigungs-E-Mail, wenn die Löschung ausgeführt wurde (sofern wir eine E-Mail-Adresse von Ihnen haben).

### Abbrechen

Bis die Löschung läuft, können Sie sie abbrechen, indem Sie sich anmelden und im Banner oben auf dem Bildschirm auf «Löschung abbrechen» klicken. Nachdem sie gelaufen ist, sind Ihr Konto, Ihre Sitzungen und Ihre Inhalte weg.

## 6. Ihre Rechte

Nach der DSGVO (Art. 15–22) und dem DSG (Art. 25–28 und 32) haben Sie das Recht auf:

- **Auskunft** über die bei uns gespeicherten Personendaten: Nutzen Sie den Export unter `/settings/profile` oder schreiben Sie uns.
- **Berichtigung** unrichtiger Daten: Bearbeiten Sie Ihr Profil oder schreiben Sie uns.
- **Löschung**: Nutzen Sie das Löschwerkzeug unter `/settings/profile`. Wir warten 30 Tage und löschen dann endgültig.
- **Einschränkung** der Verarbeitung: Schreiben Sie uns.
- **Widerspruch** gegen die Verarbeitung auf Grundlage berechtigter Interessen: Schreiben Sie uns.
- **Datenübertragbarkeit**: Der Export liefert Ihre Daten in maschinenlesbarem JSON, NDJSON und Markdown.
- **Widerruf der Einwilligung**, wo die Verarbeitung auf Einwilligung beruht (derzeit nur die Warteliste): Nutzen Sie den Abmeldelink.
- **Beschwerde** bei einer Aufsichtsbehörde (siehe §11).

Wir antworten innerhalb von 30 Tagen. Anfragen sind kostenlos, ausser sie sind offensichtlich unbegründet oder exzessiv.

## 7. Automatisierte Entscheidungsfindung

Wir treffen keine Entscheidungen mit rechtlicher oder ähnlich erheblicher Wirkung für Sie, die ausschliesslich auf automatisierter Verarbeitung beruhen. Der KI-Assistent macht nur Vorschläge, die Sie annehmen oder ablehnen. Moderationsentscheidungen trifft immer eine Person (siehe Nutzungsbedingungen, §8). Sobald kostenpflichtige Pläne angeboten werden, wird Stripe Zahlungsversuche automatisch auf Betrugsrisiken bewerten; wird eine Zahlung aus diesem Grund abgelehnt, können Sie eine Überprüfung durch eine Person verlangen.

## 8. KI-Funktionen und Transparenz

markoto enthält einen KI-Schreibassistenten und eine Suche in der Wissensdatenbank. KI-Anfragen werden über unseren eigenen LiteLLM-Proxy an diese Anbieter in der EU geleitet: Mistral AI (Texterzeugung, Sprachtranskription), Jina AI (Embeddings für die Wissensdatenbank, Extraktion des Inhalts einer einzelnen Webseite), Staan (Websuche über einen europäischen Suchindex) und Black Forest Labs (Bilderzeugung, auf eine EU-Region festgelegt).

**KI-Transparenz.** Wenn die KI in einem Dokument arbeitet, erscheint sie als eigene mitarbeitende Person, ihre Antworten sind als von der KI von markoto stammend gekennzeichnet, und ihre Änderungen werden im Aktivitätsprotokoll des Dokuments als von der KI vorgenommen erfasst.

**Training.** Wir verwenden Ihre Inhalte nicht zum Training von KI-Modellen. Die Bedingungen unserer Anbieter unterscheiden sich:

- **Jina AI** erklärt in ihren Bedingungen, dass sie Anfragedaten, Eingaben oder hochgeladene Inhalte von Kundinnen und Kunden nicht zum Training ihrer Modelle verwendet.
- **Staan** erklärt, dass Suchdaten nicht zum Training von Sprachmodellen verwendet werden.
- **Mistral AI** und **Black Forest Labs** dürfen nach ihren Standardbedingungen API-Inhalte zur Verbesserung ihrer Modelle verwenden, sofern die Kundin oder der Kunde dem nicht widerspricht (Opt-out). Wir haben bei beiden Anbietern davon Gebrauch gemacht.

### Kostenloses KI-Kontingent

Wenn Sie angemeldet sind und für den Schreibassistenten keinen eigenen Anbieter angebunden haben, nutzt der Assistent unser **kostenloses KI-Kontingent**:

- **Modell und Anbieter.** Das Kontingent nutzt das von Z.ai entwickelte Modell **GLM-5.3 Flash**. Es wird von der **Mistral AI SAS** auf deren eigener Infrastruktur über ihren **EU-Endpunkt** (Rechenzentren in der EU und in EFTA-Staaten) bereitgestellt und verarbeitet. Z.ai erhält keine Daten. Mistral AI verarbeitet die Anfragen als unser Unterauftragsverarbeiter auf Grundlage unseres Vertrags mit Mistral AI, einschliesslich des oben beschriebenen Ausschlusses des Trainings.
- **Was gesendet wird.** Ihre Eingabe, die Teile des Dokuments, die der Assistent liest, die Ergebnisse der verwendeten Werkzeuge (zum Beispiel der Text einer abgerufenen Seite oder zusammenzufassende Suchergebnisse) und, wenn Sie nach einem Bild fragen, das Bild. Die Antwort kommt auf demselben Weg zurück.
- **Wer es nutzen kann.** Nur angemeldete Nutzerinnen und Nutzer. Anonyme Besucherinnen und Besucher können die KI nicht nutzen.
- **Limiten.** Jedes Konto hat ein monatliches Limit (derzeit 500 KI-Punkte, rund 0,50 US-Dollar Modellnutzung). Zusätzlich teilen sich alle kostenlosen Konten einen monatlichen Topf. Das Kontingent steht nur zur Verfügung, solange der Topf dieses Monats reicht; ist er aufgebraucht, zeigt der Assistent dies bis zum Beginn des nächsten Monats an. Um diese Limiten durchzusetzen, erfasst unser LiteLLM-Proxy zu jeder Anfrage die Kosten, das verwendete Modell und den Zeitpunkt, verknüpft mit Ihrer internen Nutzer-ID (Aufbewahrung siehe §5).
- **Keine Gewähr.** Das Kontingent ist eine kostenlose Zusatzleistung. Wir können das Modell, die Limiten oder den Topf ändern oder das Kontingent beenden und gewährleisten nicht, dass es jederzeit verfügbar ist.
- **Ihr eigener Schlüssel ersetzt es.** Sobald Sie für den Schreibassistenten Ihren eigenen Anbieter anbinden (siehe unten), gehen Ihre Anfragen stattdessen an diesen Anbieter, und das Kontingent gilt für sie nicht mehr.

### Ihr eigener KI-Anbieter (Bring your own key)

Sie können Ihr eigenes KI-Anbieterkonto (ein OpenAI-kompatibler Dienst aus den in den Einstellungen angebotenen Möglichkeiten, zum Beispiel Mistral AI oder OpenAI) unter **Einstellungen → KI-Anbieter** anbinden, getrennt für Chat, Bilderzeugung und Sprachtranskription. Wenn Sie das tun, werden die für diese Funktion benötigten Inhalte (Ihre Eingabe, der relevante Dokumentkontext, Sprachaufnahmen und das erzeugte Ergebnis) über unseren LiteLLM-Proxy an **den von Ihnen gewählten Anbieter, auf Grundlage Ihrer eigenen Vereinbarung mit diesem**, gesendet. Wir wählen diesen Anbieter nicht aus, und er ist nicht unser Unterauftragsverarbeiter; seine Bedingungen und Datenschutzpraktiken, einschliesslich des Verarbeitungsorts und ob er mit Ihren Inhalten trainiert, sind die Ihres Vertrags mit ihm. Wir speichern Ihre Anbietereinstellungen (Anbieter-URL, Modellname und Ihren API-Schlüssel, im Ruhezustand verschlüsselt), bis Sie sie entfernen oder Ihr Konto löschen. Es werden Ihnen nur die letzten vier Zeichen des Schlüssels wieder angezeigt, der Schlüssel ist nie in Ihrem Datenexport enthalten, und wir schreiben ihn nicht in unsere Protokolle. Eingabe- und Werkzeugaufruf-Protokolle folgen der oben genannten Aufbewahrung von 90 Tagen. Embeddings nutzen stets unseren oben aufgeführten eigenen Anbieter.

Websuche und das Abrufen einzelner Seiten werden von uns bereitgestellt, ob Sie Ihren eigenen KI-Anbieter nutzen oder nicht: Die vom Assistenten formulierte Suchanfrage (bis zu 400 Zeichen; sie kann sich aus Ihrer Eingabe oder Ihrem Dokument ableiten) wird an Staan gesendet und die Webadresse, die der Assistent lesen möchte, an Jina AI, jeweils direkt von unserer Anwendung und über unser Konto bei diesen Anbietern. Die Ergebnisse werden anschliessend von Ihrem Chat-Anbieter zusammengefasst (Ihrem eigenen, falls Sie einen angebunden haben, sonst unserem). Um Kosten und Missbrauch zu begrenzen, darf jede Person nur eine begrenzte Anzahl Websuchen und Seitenabrufe ausführen (standardmässig 30 pro Stunde und 100 pro Tag). Wir zählen sie in Valkey unter Ihrer internen Benutzer-ID; die Zähler enthalten nur Zeitstempel und verfallen automatisch.

Die KI-Funktionen setzen ein Konto voraus und sind optional: Dokumentinhalte werden nur dann an einen KI-Anbieter gesendet, wenn Sie den Assistenten nutzen oder Dateien in eine Wissensdatenbank eines Workspace hochladen (diese werden von Jina AI eingebettet).

## 9. Cookies und ähnliche Technologien

markoto verwendet **nur Speicher, der für die Erbringung des von Ihnen gewünschten Dienstes unbedingt erforderlich ist**:

| Name | Zweck | Dauer |
| --- | --- | --- |
| `nuxt-session` | Hält Sie angemeldet (verschlüsseltes Sitzungs-Cookie). Wird nur gesetzt, wenn Sie sich anmelden. | 7 Tage |
| `ypad_locale` | Merkt sich Ihre Sprache. | 1 Jahr |
| `markoto-anon-creator` | Zufälliger Ersteller-Schlüssel, mit dem der Browser, der ein anonymes Dokument erstellt hat, dieses löschen kann. Nicht mit Ihnen verknüpft; wir speichern beim Dokument nur einen Hash davon. | 1 Jahr |
| `markoto-anon-terms` | Merkt sich, dass Sie die Nutzungsbedingungen akzeptiert haben, bevor Sie ein Dokument ohne Konto erstellen: die Version der Nutzungsbedingungen und den Zeitpunkt, von uns signiert, ohne Kennung. Wird nur gesetzt, wenn Sie akzeptieren. | 1 Jahr oder bis sich die Nutzungsbedingungen ändern |
| `nuxt-color-mode` (Local Storage) | Merkt sich den hellen oder dunklen Modus, falls Sie einen wählen. | Bis Sie ihn löschen |
| `markoto:preview-zoom` (Local Storage) | Merkt sich die Zoomstufe der Dokumentvorschau. | Bis Sie ihn löschen |
| `markoto-pending-invite` (Session Storage) | Bewahrt einen Link zu einer Workspace-Einladung auf, während Sie sich anmelden, um sie anzunehmen. | Bis Sie den Tab schliessen |
| Service-Worker-Cache | Lässt markoto schneller laden und offline funktionieren. | Bis Sie ihn löschen |

Wir verwenden **keine Analyse, keine Sitzungsaufzeichnung, keine Werbung und kein seitenübergreifendes Tracking**. Da dieser gesamte Speicher für einen Dienst, den Sie ausdrücklich anfordern, unbedingt erforderlich ist, bedarf er nach Art. 5 Abs. 3 der ePrivacy-Richtlinie der EU und den nationalen Gesetzen zu ihrer Umsetzung keiner Einwilligung. Nach Schweizer Recht (Art. 45c FMG) informiert Sie dieser Abschnitt darüber, und Sie können Cookies jederzeit in Ihrem Browser blockieren oder löschen; markoto kann Sie dann möglicherweise nicht angemeldet halten oder Sie keine anonymen Dokumente löschen lassen. Aus diesem Grund gibt es kein Cookie-Banner. Sollten wir je nicht notwendigen Speicher verwenden wollen, holen wir zuerst Ihre Einwilligung ein.

Unser früheres Cookie-Banner setzte ein Cookie `markoto-anon`, um sich Ihre Wahl zu merken. Wir setzen es nicht mehr; es läuft von selbst ab, und Sie können es löschen. Nachweise über Entscheide, die mit diesem Banner getroffen wurden, werden wie in §5b beschrieben aufbewahrt.

## 10. Altersvoraussetzung

Sie müssen mindestens **16 Jahre alt** sein, um markoto zu nutzen, sowohl mit Konto als auch für anonyme Dokumente, unabhängig von der Altersgrenze im Recht Ihres Landes. Wenn Sie annehmen, dass eine Person unter 16 Jahren markoto nutzt, teilen Sie uns dies bitte unter **{{privacyContactEmail}}** mit; wir löschen dann das Konto oder das Dokument.

## 11. Recht auf Beschwerde

Wenn Sie der Ansicht sind, dass wir Ihre Rechte nicht gewahrt haben, können Sie sich bei einer Datenschutzbehörde beschweren.

- **In der Schweiz:** beim Eidgenössischen Datenschutz- und Öffentlichkeitsbeauftragten (EDÖB), www.edoeb.admin.ch.
- **In der EU/im EWR:** bei der Aufsichtsbehörde des Landes, in dem Sie wohnen oder arbeiten oder in dem der mutmassliche Verstoss stattgefunden hat. Der Europäische Datenschutzausschuss veröffentlicht eine Liste. Da wir in der Schweiz niedergelassen sind, gibt es für uns nach dem «One-Stop-Shop»-Mechanismus der DSGVO keine einzelne federführende Behörde; Sie können sich daher direkt an Ihre örtliche Behörde wenden.

Wir würden es begrüssen, Ihr Anliegen zunächst direkt zu klären: Schreiben Sie an **{{privacyContactEmail}}**.

## 12. Sicherheit

Wir schützen Daten durch Transportverschlüsselung (TLS), Verschlüsselung im Ruhezustand durch unseren Speicheranbieter, verschlüsselte Datenbank-Sicherungskopien, Verschlüsselung gespeicherter Geheimnisse wie KI-Anbieterschlüssel, strikte Trennung unserer internen Dienste, Zugriff nach dem Prinzip der minimalen Rechte, gekürzte IP-Adressen in Protokollen und regelmässige Sicherheitsupdates. markoto-Konten haben keine eigenen Passwörter: Sie melden sich über GitHub oder Google an. Wenn Sie ein Dokument mit einem Passwort schützen, speichern wir davon nur einen scrypt-Hash. Die Massnahmen sind in Anhang I unseres Auftragsverarbeitungsvertrags (`/legal/dpa`) ausführlicher beschrieben.

Führt eine Verletzung des Schutzes personenbezogener Daten voraussichtlich zu einem Risiko für Sie, benachrichtigen wir die zuständige Aufsichtsbehörde innerhalb von 72 Stunden, wo die DSGVO dies verlangt (Art. 33 DSGVO), und den EDÖB so rasch wie möglich, wo das DSG dies verlangt (Art. 24 DSG). Führt die Verletzung voraussichtlich zu einem hohen Risiko für Sie, informieren wir auch Sie unverzüglich.

## 13. Verzeichnis der Verarbeitungszwecke

Die folgende Tabelle wird aus unserem internen Register der Verarbeitungszwecke erzeugt und führt nur auf, was diese Installation tatsächlich tut (zum Beispiel wird die Abrechnung erst aufgeführt, wenn kostenpflichtige Pläne aktiviert sind). Die Tabelle wird auf Englisch geführt.

{{processingPurposesTable}}

## 14. Änderungen dieser Erklärung

Dies ist **Version {{currentVersion}}**, gültig ab **{{effectiveDate}}**. Wesentliche Änderungen (neue Verarbeitungszwecke, neue Unterauftragsverarbeiter, geänderte Aufbewahrung) ändern die Version und führen zu einer Aufforderung im Produkt, die neue Version zu akzeptieren. Frühere Versionen sind auf Anfrage bei **{{privacyContactEmail}}** erhältlich.

### Änderungsverlauf

- **v8 (2026-11-03).** Die Zwecke «Produktanalyse» und «Sitzungsaufzeichnung» sowie das Cookie-Banner entfernt: Beides war nie im Einsatz, und markoto verwendet nur unbedingt erforderlichen Speicher (aufgeführt in §9). Das Schweizer DSG neben der DSGVO sowie die Länder, in die Daten übermittelt werden (§4), ergänzt. Anonyme Dokumente (Akzeptieren der Nutzungsbedingungen, Bot-Prüfung, Löschung nach 30 statt 180 Tagen), noindex für Dokumente und Missbrauchsmeldungen ohne Konto, mit Eingangsbestätigung, Mitteilung des Entscheids und Begründung, beschrieben (§2b). Die Aufbewahrung von Sicherungskopien (etwa 30 Tage), von Audit-Protokolleinträgen (2 Jahre) und von Missbrauchsmeldungen (1 Jahr nach Abschluss des Falls) angegeben. Die Angaben zum Passwort-Hashing, zur Altersregel (überall 16 Jahre), zur Beschreibung der KI-Kennzeichnung und zum KI-Training je Anbieter korrigiert. Kostenloses KI-Kontingent für angemeldete Nutzerinnen und Nutzer ergänzt (GLM-5.3 Flash von Z.ai, bereitgestellt und verarbeitet von Mistral AI über deren EU-Endpunkt; Z.ai erhält keine Daten), mit monatlichem Limit pro Konto und gemeinsamem Monatstopf, sowie die Aufbewahrung der KI-Nutzungsdaten (§5, §8).
- **v7 (2026-10-27).** Verarbeitungszweck `workspace_invitations` hinzugefügt (berechtigtes Interesse): Lädt ein Admin eines Arbeitsbereichs jemanden per E-Mail ein, speichern wir diese E-Mail-Adresse, die angebotene Rolle und die einladende Person in einer offenen Einladung, bis die Person sie annimmt oder ablehnt, ein Admin sie zurückzieht oder sie nach 14 Tagen abläuft. Niemand tritt einem Arbeitsbereich ohne Zustimmung bei. Ist E-Mail eingerichtet, wird pro Einladung eine Einladungs-E-Mail über Resend versendet (höchstens drei pro Adresse und Tag). Gespeichert bei OVHcloud (EU).
- **v6 (2026-10-26), redaktionelle Anpassung an den ausschliesslich kostenlosen Dienst.** Stripe und die Abrechnung werden als erst relevant beschrieben, sobald kostenpflichtige Pläne angeboten werden (die Liste der Unterauftragsverarbeiter und das Verzeichnis lassen Stripe aus, solange die Abrechnung ausgeschaltet ist). Das Verzeichnis der Verarbeitungszwecke wird nun tatsächlich in Ziffer 13 angezeigt. Angaben zur Aufbewahrung der Audit-Protokolle, zur Bereinigung anonymer Dokumente (180 Tage Inaktivität), zum abgeschafften Interaktionszähler und zur (nicht vorhandenen) kontoweiten KI-Abmeldung wurden korrigiert.
- **v6 (2026-10-26).** Verarbeitungszweck `user_directed_ai_provider` hinzugefügt: Sie können Ihren eigenen KI-Anbieter anbinden (Chat, Bilderzeugung, Sprachtranskription). Inhalte für diese Funktionen werden dann auf Grundlage Ihrer Vereinbarung mit dem von Ihnen gewählten Anbieter an diesen gesendet; wir speichern Ihre Anbietereinstellungen mit im Ruhezustand verschlüsseltem API-Schlüssel, bis Sie sie entfernen oder Ihr Konto löschen. Websuche und Seitenabruf werden von uns für alle Nutzenden bereitgestellt, auch für solche mit eigenem KI-Anbieter: Suchanfragen gehen an Staan und abgerufene Webadressen an Jina AI; zudem führen wir pro Person stündliche und tägliche Nutzungszähler (nur Zeitstempel, kein Inhalt) in Valkey.
- **v5 (2026-10-26).** Verarbeitungszweck `paid_plans_waitlist` hinzugefügt (Einwilligung, Double-Opt-in): E-Mail-Adresse, Sprache, Einwilligungsnachweis und optionale Kontoverknüpfung, aufbewahrt bis zur Abmeldung oder spätestens 3 Monate nach der Ankündigung des Starts kostenpflichtiger Pläne; unbestätigte Anmeldungen werden nach 7 Tagen gelöscht. Gespeichert bei OVHcloud (EU); Bestätigungs-E-Mails über Resend.
- **v2 (2026-05-05).** Resend, Inc. als Unterauftragsverarbeiter für den Versand von Transaktions-E-Mails hinzugefügt (Löschbestätigungen, Benachrichtigungen über bereitstehende Datenexporte). E-Mail-Metadaten werden von Resend 30 Tage aufbewahrt; Inhalte werden nicht archiviert. Der Verarbeitungszweck `transactional_email` verweist im Register der Rechtsgrundlagen nun auf Resend.
- **v1 (2026-05-04).** Erstveröffentlichung.
