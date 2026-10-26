---
slug: privacy
locale: de
version: 6
effectiveDate: 2026-10-26
translationStatus: machine-translated
---

# Datenschutzerklärung

> **Kurz gesagt:** markoto speichert die Dokumente, die Sie schreiben, die Kommentare, die Sie hinterlassen, und das Minimum, das wir für den Betrieb Ihres Kontos benötigen. Der Dienst ist derzeit kostenlos; kostenpflichtige Pläne werden noch nicht angeboten. Die KI-Funktionen laufen bei Anbietern in der EU (Mistral AI für Text und Sprache, Jina AI für Embeddings und das Abrufen einzelner Seiten, Staan für die Websuche, Black Forest Labs für die Bilderzeugung), es sei denn, Sie binden Ihren eigenen KI-Anbieter an; dann gehen Ihre KI-Inhalte an den von Ihnen gewählten Anbieter. Wir verkaufen Ihre Daten nicht, schalten keine Werbung und trainieren keine KI mit Ihren Inhalten. Sie können die über Sie gespeicherten Daten jederzeit exportieren und Ihr Konto in Ihren Einstellungen löschen.

---

## 1. Wer wir sind

markoto wird von **{{controllerName}}** ({{controllerAddress}}) betrieben. Bei Datenschutzfragen schreiben Sie an **{{privacyContactEmail}}**.

Im Sinne der Datenschutz-Grundverordnung (Verordnung (EU) 2016/679 – «DSGVO») ist markoto der **Verantwortliche** für die personenbezogenen Daten, die Sie uns direkt mitteilen (Ihr Konto und, falls Sie sich eintragen, die Warteliste für kostenpflichtige Pläne). Wenn Sie markoto in einem Workspace nutzen, der einer anderen Partei gehört, ist deren Eigentümerin bzw. Eigentümer der Verantwortliche für alle Inhalte, die Sie in diesen Workspace einbringen, und markoto handelt als **Auftragsverarbeiter** auf Grundlage eines Auftragsverarbeitungsvertrags (siehe `/legal/dpa`).

## 2. Welche Daten wir verarbeiten und warum

Wir folgen dem Grundsatz der Datenminimierung: Wir erheben für jeden Zweck nur die kleinste erforderliche Datenmenge und sagen Ihnen, was der jeweilige Zweck ist.

Die vollständige Tabelle der Verarbeitungszwecke – einschliesslich Rechtsgrundlage, Datenkategorien, Aufbewahrungsdauer und beteiligter Unterauftragsverarbeiter – finden Sie im Verzeichnis in Ziffer 13 unten, das aus unserem internen Register erzeugt wird. Jede Änderung dieses Verzeichnisses gilt als wesentliche Änderung dieser Erklärung und erhöht die Versionsnummer (siehe Ziffer 14).

## 3. Rechtsgrundlagen (Art. 6 DSGVO)

Jede Verarbeitung stützt sich auf eine der folgenden Rechtsgrundlagen:

- **Vertrag** (Art. 6 Abs. 1 lit. b) – für alles, was zur Erbringung des Dienstes erforderlich ist, für den Sie sich angemeldet haben: Kontoerstellung, Dokumentenspeicherung, KI-Unterstützung und – sobald kostenpflichtige Pläne angeboten werden – Abrechnung.
- **Rechtliche Verpflichtung** (Art. 6 Abs. 1 lit. c) – für die Audit-Protokollierung der Sicherheit und, sobald kostenpflichtige Pläne angeboten werden, für steuerrechtliche Aufbewahrungspflichten (Abrechnungsdaten).
- **Berechtigtes Interesse** (Art. 6 Abs. 1 lit. f) – für Betrugs- und Missbrauchsprävention, Fehlerüberwachung und Sicherheitstelemetrie. Sie können der Verarbeitung auf dieser Grundlage widersprechen (siehe Ziffer 6).
- **Einwilligung** (Art. 6 Abs. 1 lit. a) – für Produktanalyse und Sitzungsaufzeichnung (wir laden diese nur, wenn Sie im Cookie-Banner eingewilligt haben) sowie für die Warteliste für kostenpflichtige Pläne (nur wenn Sie bei der Anmeldung das Einwilligungskästchen ankreuzen und anschliessend die E-Mail bestätigen, die wir Ihnen senden). Sie können jederzeit widerrufen.

## 4. Unterauftragsverarbeiter und internationale Übermittlungen

Wir setzen eine kleine Zahl von Unterauftragsverarbeitern ein, die alle durch Verträge nach Art. 28 DSGVO gebunden sind. Die aktuelle Liste finden Sie unter `/legal/sub-processors`. Diese Liste zeigt nur die Anbieter, die diese Installation tatsächlich nutzt: Stripe (Zahlungsabwicklung) erscheint zum Beispiel erst, wenn kostenpflichtige Pläne aktiviert sind, und ein KI-Anbieter, den **Sie** selbst anbinden (siehe Ziffer 8), ist nicht unser Unterauftragsverarbeiter und wird nicht aufgeführt.

Verarbeitet ein Unterauftragsverarbeiter Daten ausserhalb des Europäischen Wirtschaftsraums, stützen wir uns auf:

- den Angemessenheitsbeschluss zum **EU-US Data Privacy Framework** (10. Juli 2023) für in den USA ansässige, DPF-zertifizierte Empfänger, UND
- **Standardvertragsklauseln** (2021/914) als Rückfalllösung für den Fall, dass der Angemessenheitsbeschluss zum DPF aufgehoben wird.

Workspace-Eigentümerinnen und -Eigentümer als Kundschaft informieren wir mindestens 30 Tage im Voraus über jeden neuen Unterauftragsverarbeiter.

## 5. Speicherort und Aufbewahrung

Anwendungsdaten und Dokumente liegen in der verwalteten PostgreSQL-Datenbank und im Object Storage von OVHcloud in der Europäischen Union (Frankreich). Die KI-bezogene Verarbeitung erfolgt durch Anbieter in der EU – Mistral AI (Frankreich), Jina AI (Deutschland), Staan (EU) und Black Forest Labs (auf eine EU-Region festgelegt) – über unseren selbst betriebenen LiteLLM-Proxy. Solange der Dienst kostenlos ist, verarbeiten wir keine Zahlungsdaten; sobald kostenpflichtige Pläne angeboten werden, werden Abrechnungsdaten bei Stripe gehalten. Fehlertelemetrie der Anwendung wird von Sentry in dessen EU-Region (Frankfurt) verarbeitet. Transaktions-E-Mails (Löschbestätigungen, Benachrichtigungen über bereitstehende Datenexporte, Benachrichtigungen bei Datenschutzverletzungen) werden über Resend versandt; nur Empfängeradresse, Betreffzeile und Nachrichtentext durchlaufen die Systeme von Resend, und Resend speichert diese 30 Tage lang zur Überwachung der Zustellbarkeit.

Die Aufbewahrung richtet sich nach dem Zeitplan je Zweck im Verzeichnis in Ziffer 13. Als allgemeine Regel gilt:

- **Kontodaten** bleiben bestehen, bis Sie die Löschung verlangen.
- **Dokumente und Inhalte** bleiben bestehen, bis Sie sie oder Ihr Konto löschen.
- **Anonyme Dokumente** (ohne Anmeldung erstellt und nicht Teil eines Workspace) werden im gehosteten Dienst nach 180 Tagen ohne Aktivität automatisch gelöscht. Selbst betriebene Installationen können einen anderen Zeitraum festlegen oder diese Bereinigung abschalten. Dokumente, die einem Konto gehören, und Workspace-Dokumente werden nicht automatisch gelöscht.
- **KI-Eingabe- und Werkzeugaufruf-Protokolle** werden 90 Tage lang zur Missbrauchsprüfung aufbewahrt und dann gelöscht.
- **Audit-Protokolle** werden so lange aufbewahrt, wie es für Sicherheits- und rechtliche Zwecke erforderlich ist. Wenn Sie Ihr Konto löschen, wird Ihre Konto-ID daraus entfernt (siehe Ziffer 5b).
- **Abrechnungsdaten** gibt es nicht, solange der Dienst kostenlos ist. Sobald kostenpflichtige Pläne angeboten werden, werden sie für die nach EU- und mitgliedstaatlichem Steuerrecht vorgeschriebene Mindestdauer aufbewahrt (in der Regel 7–10 Jahre).
- **Metadaten von Transaktions-E-Mails** (Empfänger, Sendezeitpunkt, Zustellstatus) werden von Resend 30 Tage lang aufbewahrt; E-Mail-Inhalte speichern wir nach der Zustellung nicht.
- **Warteliste für kostenpflichtige Pläne.** Wenn Sie sich auf der Preisseite in die Warteliste eintragen, speichern wir Ihre E-Mail-Adresse, die Sprache bei der Anmeldung, welche Version des Einwilligungstextes Sie akzeptiert haben, den Zeitpunkt von Anmeldung und Bestätigung sowie – falls Sie angemeldet waren – eine Verknüpfung mit Ihrem Konto. Wir speichern Ihre IP-Adresse nicht. Wir verwenden dies ausschliesslich, um Sie zu informieren, wenn kostenpflichtige Pläne starten. Ihr Eintrag zählt erst, nachdem Sie den Bestätigungslink in unserer E-Mail angeklickt haben (Double-Opt-in); unbestätigte Einträge werden nach 7 Tagen gelöscht. Jede E-Mail enthält einen Abmeldelink, der Ihren Eintrag sofort löscht; andernfalls löschen wir die Liste spätestens 3 Monate nach Versand der Ankündigung des Starts. Die Löschung Ihres Kontos löscht auch einen verknüpften Eintrag, und Ihr Datenexport enthält ihn. Die Bestätigungs-E-Mail wird über Resend versandt; die Liste selbst liegt in der verwalteten PostgreSQL-Datenbank von OVHcloud in der EU.

## 5b. Was bei der Löschung Ihres Kontos geschieht

Wir möchten völlig transparent darlegen, was die Löschung bewirkt. Die Schaltfläche unter `/settings/profile` plant die endgültige Löschung Ihres Kontos **in 30 Tagen** ein. Während dieser Karenzzeit bleibt Ihr Konto nutzbar; Sie können auf jeder Seite, die das Löschbanner zeigt, abbrechen. Nach Ablauf der 30 Tage läuft Folgendes automatisch ab – es gibt keine weitere Bestätigung und keine Möglichkeit mehr, etwas wiederherzustellen.

### Was endgültig gelöscht wird

- **Ihr Kontodatensatz** – Name, E-Mail, OAuth-Kennungen, Einstellungen, Sprache, Altersbestätigung, akzeptierte Versionen der Richtlinien.
- **Jedes Dokument, das Ihnen gehört** – einschliesslich Dokumenten, die Sie mit Mitwirkenden im Bearbeitungsmodus geteilt haben. Mitwirkende verlieren gleichzeitig den Zugriff auf diese Dokumente. *Wenn Mitwirkende ein Dokument behalten sollen, übertragen Sie es ihnen oder duplizieren Sie es unter ihrem Konto, bevor Sie die Löschung verlangen.*
- **Jedes gespeicherte Theme** unter Ihrem Konto.
- **Jeder Workspace, in dem Sie das einzige Mitglied sind** – und jedes Dokument und jede Wissensdatei darin. *Wenn Sie Workspace-Inhalte behalten möchten, laden Sie vor der Löschung Ihres Kontos entweder ein weiteres Mitglied ein oder laden Sie die Dokumente zuvor mit der Datenexport-Funktion unter `/settings/profile` herunter.*
- **Ihre KI-Nutzung** – frühere Eingaben (wir bewahren diese vertraulich 90 Tage lang zur Missbrauchsprüfung auf), offene KI-Sitzungen sowie Einstellungen eines selbst angebundenen KI-Anbieters (Bring your own key) samt verschlüsselten API-Schlüsseln (siehe Ziffer 8).
- **Ihre Datenexport-Aufträge** und alle ZIP-Dateien, die wir für Sie vorbereitet hatten.
- **Ihr Stripe-Kundendatensatz, sofern vorhanden** (erst möglich, wenn kostenpflichtige Pläne angeboten werden) – wir weisen Stripe an, ihn zu löschen. Stripe bewahrt die zugrunde liegenden Rechnungs- und Zahlungsunterlagen unabhängig von unserer Anweisung für die steuerrechtlich vorgeschriebene Dauer auf (in der Regel 7 bis 10 Jahre).

### Was anonymisiert wird – es bleibt ohne Ihren Namen auf der Plattform

- **Kommentare, die Sie zu Dokumenten verfasst haben, die Ihnen nicht gehören** – der Text bleibt, damit die Unterhaltung für andere Beteiligte verständlich bleibt, aber Ihr Name und Ihre Kontoverknüpfung werden durch `[gelöschter Nutzer]` ersetzt.
- **Audit-Protokolleinträge** – wir behalten unser internes Sicherheitsprotokoll ohne Ihre Konto-ID, aber mit der zugehörigen Aktion. Rechtsgrundlage: berechtigtes Interesse an der Betrugsprävention und rechtliche Verpflichtung. Die Aufbewahrung folgt unserer allgemeinen Audit-Protokoll-Praxis.
- **Aktivitätsprotokolleinträge** – Ihre Bearbeitungen, Wiederherstellungen und Theme-Änderungen an Dokumenten, die Ihnen NICHT gehören, bleiben im Aktivitätsverlauf des Dokuments unter «Anonym» bestehen. Bearbeitungen an eigenen Dokumenten verschwinden mit dem Dokument.
- **Einträge im Einwilligungsprotokoll** – wir anonymisieren die Nutzerverknüpfung, behalten aber den historischen Eintrag, damit wir nachweisen können, dass eine Einwilligung erteilt wurde (Anforderung nach Art. 7 Abs. 1 DSGVO).

### Was mit Workspaces geschieht, in denen Sie gemeinsam mit anderen Admin sind

Sind Sie Admin eines Workspace, der bei der Löschung Ihres Kontos mindestens ein weiteres Mitglied hat, **befördern wir automatisch eines der verbleibenden Mitglieder zum Admin** – das am längsten beteiligte Mitglied, wobei ein bestehender Admin, dann ein bestehender Editor, dann ein Betrachter bevorzugt wird. Der Workspace und seine Inhalte bleiben für die verbleibenden Mitglieder erhalten. Der neue Admin wird nach der Beförderung benachrichtigt.

Das Herkunftsfeld «Eigentümer» des Workspace wird dem neuen Admin zugewiesen, damit die Fremdschlüssel konsistent bleiben. Die Berechtigung richtete sich stets nach der Mitgliedsrolle, nicht nach dem Eigentümerfeld; dies ist also reine Buchführung.

### Workspaces, die Sie zuvor von Hand bereinigen sollten

Da das kaskadierende Löschen eines Workspace auch Inhalte entfernt, die anderen Mitgliedern gehören, wenn Sie die einzige Person im Workspace waren, empfehlen wir dringend, vor der Kontolöschung Folgendes zu tun, wenn Sie sicherstellen möchten, dass die Arbeit anderer erhalten bleibt:

- Für jeden Workspace, in dem Sie das einzige Mitglied sind, dessen Inhalt Sie aber behalten möchten: laden Sie zuerst mindestens eine Person mit Admin-Rolle ein, die den Workspace dann übernimmt.
- Für jedes Dokument, das eine andere Person behalten soll: übertragen Sie das Eigentum (verschieben Sie es aus Ihrem Workspace in einen, der ihr gehört, ODER duplizieren Sie es unter ihrem Konto) oder lassen Sie sie zuvor eine Kopie herunterladen.
- Für Dateien der Wissensdatenbank, die erhalten bleiben sollen: laden Sie sie ausserhalb von markoto herunter, da sie mit dem Workspace gelöscht werden.

### Ihr Datenexport

Vor der Beantragung der Kontolöschung können Sie die Funktion **Datenexport** unter `/settings/profile` nutzen, um ein ZIP-Archiv mit allem zu erhalten, was wir über Sie speichern – Dokumente als Markdown, von Ihnen verfasste Kommentare, Workspace-Mitgliedschaften, KI-Nutzungsprotokolle, Ihre KI-Anbietereinstellungen (Anbieter-URL, Modell und Funktion – nie der API-Schlüssel), gegebenenfalls Ihren Wartelisteneintrag, Einwilligungsentscheide und, sobald es kostenpflichtige Pläne gibt, den Abrechnungsverlauf. Dies ist ein separater Ablauf, der eine herunterladbare Datei erzeugt, die Sie unabhängig vom Schicksal Ihres markoto-Kontos behalten können.

### Wie lange die Kaskade tatsächlich dauert

Ein Hintergrundjob führt die Kaskade einmal pro Stunde aus. Im ungünstigsten Fall sind Ihre Daten rund eine Stunde nach Ablauf der 30-tägigen Karenzzeit vollständig gelöscht. Sie erhalten eine Bestätigungs-E-Mail, wenn die Löschung ausgeführt wurde (sofern eine E-Mail-Adresse hinterlegt ist).

### Abbrechen

Bis die Kaskade läuft, können Sie die geplante Löschung abbrechen, indem Sie sich anmelden und auf einer beliebigen Seite auf «Löschung abbrechen» klicken (während der Karenzzeit erscheint oben auf dem Bildschirm ein Banner). Nachdem die Kaskade gelaufen ist, sind Ihr Konto, Ihre Sitzungen und Ihre Inhalte weg – es gibt keinen Weg zur Wiederherstellung.

## 6. Ihre Rechte (Art. 15–22 DSGVO)

Sie haben das Recht auf:

- **Auskunft** über die bei uns gespeicherten personenbezogenen Daten (Art. 15) – nutzen Sie das Exportwerkzeug unter `/settings/profile`.
- **Berichtigung** unrichtiger Daten (Art. 16) – bearbeiten Sie Ihr Profil oder schreiben Sie uns.
- **Löschung** Ihrer Daten («Recht auf Vergessenwerden», Art. 17) – nutzen Sie das Löschwerkzeug unter `/settings/profile`. Wir warten 30 Tage und löschen dann endgültig.
- **Einschränkung** der Verarbeitung (Art. 18) – schreiben Sie uns.
- **Widerspruch** gegen die Verarbeitung auf Grundlage berechtigter Interessen (Art. 21) – schreiben Sie uns.
- **Datenübertragbarkeit** (Art. 20) – das Exportwerkzeug liefert Ihre Daten in maschinenlesbarem JSON, NDJSON und Markdown.
- **Widerruf der Einwilligung** (Art. 7 Abs. 3), wo die Verarbeitung auf Einwilligung beruht – schalten Sie den jeweiligen Zweck im Cookie-Banner um (Datenschutz-Symbol in der Fusszeile).
- **Beschwerde** bei einer Aufsichtsbehörde (Art. 77) – siehe Ziffer 11.

Wir beantworten alle Anfragen innerhalb von 30 Tagen. Für diese Anfragen erheben wir keine Gebühren, ausser bei offensichtlich unbegründeten oder exzessiven Anfragen.

## 7. Automatisierte Entscheidungsfindung

markoto trifft keine Entscheidungen, die ausschliesslich auf automatisierter Verarbeitung beruhen und Ihnen gegenüber rechtliche oder ähnlich erhebliche Wirkung entfalten. Der KI-Assistent macht Vorschläge, die Sie annehmen oder ablehnen – die Urheberschaft liegt stets bei Ihnen. Sobald kostenpflichtige Pläne angeboten werden, wird Stripe eine automatisierte Risikobewertung von Zahlungsversuchen vornehmen; wird ein Versuch auf dieser Grundlage abgelehnt, können Sie eine menschliche Überprüfung verlangen, indem Sie uns schreiben.

## 8. KI-Funktionen und Transparenz

markoto enthält einen KI-Schreibassistenten und ein Retrieval-System für die Wissensdatenbank. KI-Anfragen werden über unseren selbst betriebenen LiteLLM-Proxy an Anbieter in der EU geleitet: Mistral AI (Texterzeugung, Sprachtranskription über Voxtral), Jina AI (Embeddings für die Wissensdatenbank, Inhaltsextraktion einzelner URLs), Staan (Websuche über einen eigenen europäischen Suchindex, ausschliesslich EU-Routing) und Black Forest Labs (Bilderzeugung, auf eine EU-Region festgelegt). Websuchanfragen laufen nicht mehr über US-Suchdienste. Wir legen dies in der Benutzeroberfläche offen – jede KI-gestützte Nachricht trägt ein sichtbares «KI»-Zeichen, und jeder in ein öffentliches Dokument eingefügte KI-generierte Inhalt wird mit einem Transparenzhinweis versehen. Keiner dieser Anbieter verwendet API-Inhalte in den von uns genutzten Tarifen zum Training seiner Modelle.

### Ihr eigener KI-Anbieter (Bring your own key)

Sie können Ihr eigenes KI-Anbieterkonto anbinden (ein OpenAI-kompatibler Dienst aus den in den Einstellungen angebotenen Möglichkeiten, zum Beispiel Mistral AI oder OpenAI; selbst betriebene markoto-Installationen können weitere zulassen), unter **Einstellungen → KI-Anbieter**, getrennt für Chat, Bilderzeugung und Sprachtranskription. Wenn Sie das tun, werden die für diese Funktion benötigten Inhalte – Ihre Eingabe, der relevante Dokumentkontext, Sprachaufnahmen und das erzeugte Ergebnis – über unseren LiteLLM-Proxy an **den von Ihnen gewählten Anbieter, auf Grundlage Ihrer eigenen Vereinbarung mit diesem Anbieter** gesendet. markoto wählt diesen Anbieter nicht aus, und er ist keiner unserer Unterauftragsverarbeiter; seine Bedingungen und Datenschutzpraktiken (einschliesslich des Verarbeitungsorts und ob er API-Inhalte zum Training verwendet) sind die Ihres Vertrags mit ihm. Wir speichern Ihre Anbietereinstellungen (Anbieter-URL, Modellname und Ihren API-Schlüssel, im Ruhezustand verschlüsselt), bis Sie sie entfernen oder Ihr Konto löschen; es werden Ihnen nur die letzten vier Zeichen des Schlüssels wieder angezeigt, der Schlüssel ist nie in Ihrem Datenexport enthalten (der Export enthält nur Anbieter-URL, Modell und Funktion), und wir schreiben ihn nicht in unsere Anwendungsprotokolle. Eingabe- und Werkzeugaufruf-Protokolle folgen der oben genannten Aufbewahrung von 90 Tagen. Embeddings, Websuche und das Abrufen einzelner Seiten nutzen stets unsere oben aufgeführten eigenen Anbieter in der EU.

Die Nutzung der KI-Funktionen setzt eine Anmeldung voraus. Sie sind optional: Dokumentinhalte werden nur dann an einen KI-Anbieter gesendet, wenn Sie den Assistenten aufrufen oder Dateien in eine Wissensdatenbank eines Workspace hochladen (diese werden von Jina AI eingebettet).

## 9. Cookies und ähnliche Technologien

Wir verwenden notwendigen Speicher (ein Sitzungs-Cookie, eine Spracheinstellung und Ihren Einwilligungsentscheid selbst), um Sie angemeldet zu halten und Ihre Einstellungen zu merken – dies erfordert nach der ePrivacy-Richtlinie keine Einwilligung. Produktanalyse und Sitzungsaufzeichnung nutzen wir nur mit Ihrer Einwilligung, die Sie jederzeit über den Link «Datenschutzeinstellungen» in der Fusszeile jeder Seite erteilen oder widerrufen können.

Wir verwenden keine seitenübergreifenden Werbe-Tracker und verkaufen oder teilen keine Daten mit Werbetreibenden.

## 10. Kinder

markoto richtet sich nicht an Kinder unter dem digitalen Einwilligungsalter Ihres Landes (in den meisten EU-Mitgliedstaaten 16 Jahre; in einigen niedriger). Wenn Sie feststellen, dass ein Kind entgegen dieser Regel ein Konto erstellt hat, melden Sie dies bitte an **{{privacyContactEmail}}**.

## 11. Recht auf Beschwerde

Wenn Sie der Ansicht sind, dass wir Ihre Rechte nicht gewahrt haben, haben Sie das Recht, bei einer Datenschutz-Aufsichtsbehörde Beschwerde einzulegen.

- **In der EU/im EWR:** Sie können sich an die Aufsichtsbehörde Ihres gewöhnlichen Aufenthaltsorts, Ihres Arbeitsorts oder des Orts des mutmasslichen Verstosses wenden. Eine Liste der Aufsichtsbehörden der EU/des EWR veröffentlicht der Europäische Datenschutzausschuss. Da wir in der Schweiz (ausserhalb der EU/des EWR) niedergelassen sind, fallen wir nicht unter den «One-Stop-Shop»-Mechanismus der DSGVO; es gibt daher keine einzelne federführende Behörde – Sie können sich direkt an Ihre örtliche Behörde wenden.
- **In der Schweiz:** zuständig ist der Eidgenössische Datenschutz- und Öffentlichkeitsbeauftragte (EDÖB).

Wir würden es zudem begrüssen, Ihr Anliegen zunächst direkt zu klären – schreiben Sie uns bitte an **{{privacyContactEmail}}**.

## 12. Sicherheit

Wir schützen Daten durch Transportverschlüsselung (TLS), Verschlüsselung im Ruhezustand auf der Plattformebene von OVHcloud, scrypt-Passwort-Hashing und IP-Kürzung in Audit-Protokollen. Im Fall einer Verletzung des Schutzes personenbezogener Daten verpflichten wir uns, die zuständige Aufsichtsbehörde gemäss Art. 33 DSGVO innerhalb von 72 Stunden zu benachrichtigen.

Wenn uns eine Datenschutzverletzung bekannt wird, die Sie betrifft, benachrichtigen wir die Aufsichtsbehörde innerhalb von 72 Stunden und Sie unverzüglich, wenn die Verletzung ein hohes Risiko für Ihre Rechte darstellt.

## 13. Verzeichnis der Verarbeitungszwecke

Die folgende Tabelle wird aus unserem internen Register der Verarbeitungszwecke erzeugt und führt nur auf, was diese Installation tatsächlich tut (zum Beispiel wird die Abrechnung erst aufgeführt, wenn kostenpflichtige Pläne aktiviert sind). Die Tabelle wird auf Englisch geführt.

{{processingPurposesTable}}

## 14. Änderungen dieser Erklärung

Dies ist **Version {{currentVersion}}**, gültig ab **{{effectiveDate}}**. Wesentliche Änderungen (neue Verarbeitungszwecke, neue Unterauftragsverarbeiter, geänderte Aufbewahrung) führen zu einer Erhöhung der Versionsnummer und einer Aufforderung zur erneuten Zustimmung im Produkt. Frühere Versionen sind auf Anfrage bei **{{privacyContactEmail}}** erhältlich.

### Änderungsverlauf

- **v6 (2026-10-26), redaktionelle Anpassung an den ausschliesslich kostenlosen Dienst.** Stripe und die Abrechnung werden als erst relevant beschrieben, sobald kostenpflichtige Pläne angeboten werden (die Liste der Unterauftragsverarbeiter und das Verzeichnis lassen Stripe aus, solange die Abrechnung ausgeschaltet ist). Das Verzeichnis der Verarbeitungszwecke wird nun tatsächlich in Ziffer 13 angezeigt. Angaben zur Aufbewahrung der Audit-Protokolle, zur Bereinigung anonymer Dokumente (180 Tage Inaktivität), zum abgeschafften Interaktionszähler und zur (nicht vorhandenen) kontoweiten KI-Abmeldung wurden korrigiert.
- **v6 (2026-10-26).** Verarbeitungszweck `user_directed_ai_provider` hinzugefügt: Sie können Ihren eigenen KI-Anbieter anbinden (Chat, Bilderzeugung, Sprachtranskription). Inhalte für diese Funktionen werden dann auf Grundlage Ihrer Vereinbarung mit dem von Ihnen gewählten Anbieter an diesen gesendet; wir speichern Ihre Anbietereinstellungen mit im Ruhezustand verschlüsseltem API-Schlüssel, bis Sie sie entfernen oder Ihr Konto löschen.
- **v5 (2026-10-26).** Verarbeitungszweck `paid_plans_waitlist` hinzugefügt (Einwilligung, Double-Opt-in): E-Mail-Adresse, Sprache, Einwilligungsnachweis und optionale Kontoverknüpfung, aufbewahrt bis zur Abmeldung oder spätestens 3 Monate nach der Ankündigung des Starts kostenpflichtiger Pläne; unbestätigte Anmeldungen werden nach 7 Tagen gelöscht. Gespeichert bei OVHcloud (EU); Bestätigungs-E-Mails über Resend.
- **v2 (2026-05-05).** Resend, Inc. als Unterauftragsverarbeiter für den Versand von Transaktions-E-Mails hinzugefügt (Löschbestätigungen, Benachrichtigungen über bereitstehende Datenexporte). E-Mail-Metadaten werden von Resend 30 Tage aufbewahrt; Inhalte werden nicht archiviert. Der Verarbeitungszweck `transactional_email` verweist im Register der Rechtsgrundlagen nun auf Resend.
- **v1 (2026-05-04).** Erstveröffentlichung.
