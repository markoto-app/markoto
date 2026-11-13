<!-- Ein Runbook für den Bereitschaftsdienst eines Service oder einer Plattform. Der Titelblock zeigt Titel, die abgedeckten Services (Untertitel), das verantwortliche Team und das Datum; das Datum steht auf jeder Seite, weil Ausdrucke veralten. Die Abschnittsnummern setzt das Design, so funktioniert „siehe 3.2“ auch am Telefon. -->

# So benutzen Sie dieses Runbook

<!-- Zwei, drei Sätze: für wen das Runbook ist, welche Services es abdeckt und wie ein Ablauf aufgebaut ist (der Alarm, der hierher führt, dann die Schritte der Reihe nach). Bitte die Leserin oder den Leser, im Incident-Kanal mitzuschreiben, was sie tun. -->

> [!IMPORTANT]
> Wenn Kundinnen und Kunden betroffen sind und Sie die Ursache nach 15 Minuten nicht gefunden haben: Incident ausrufen und die Incident-Leitung alarmieren.

## Vor Ihrer Schicht

<!-- Eine Checkliste für die Übergabe: Zugang funktioniert, Tokens sind gültig, der Pager erreicht die Person, die Übergabenotizen sind gelesen. Den Befehl, der den Punkt prüft, in Backticks setzen. -->

- [ ] Sie erreichen die Produktionsumgebung: `befehl zum prüfen`.
- [ ] Ihre Zugangsdaten gelten für die ganze Schicht.
- [ ] Die Pager-App ist installiert und ein Testalarm kam an.
- [ ] Sie haben die Übergabenotizen gelesen.

# Schweregrade

<!-- Eine Zeile pro Stufe, die schwerste zuerst. Definition aus Sicht der Kundschaft, ein konkretes Beispiel mit Schwellenwert und was die Stufe verlangt (wen alarmieren, wann die Statusseite aktualisiert wird). -->

| Stufe | Definition | Beispiele | Reaktion |
|---|---|---|---|
| SEV-1 | | | |
| SEV-2 | | | |
| SEV-3 | | | |

# Abläufe

<!-- Ein H2 pro Alarm, genau so benannt wie im Pager, damit man danach suchen kann. Beginne mit der fetten Zeile „Alarm:“ (Bedingung und Schwellenwert), dann nummerierte Schritte in der Reihenfolge, in der sie zu tun sind: was prüfen, der genaue Befehl, welches Ergebnis was bedeutet und wann eskalieren. Mehrzeilige Befehle als Codeblock in den Schritt setzen. Den Block für jeden weiteren Alarm kopieren. -->

## AlarmName

**Alarm:** Bedingung und Schwellenwert, die ihn auslösen.

1. Das Dashboard der betroffenen Komponente prüfen.
2. Die letzte Änderung ansehen:
   ```bash
   befehl --ausfuehren
   ```
3. Ist die Änderung die Ursache, zurückrollen. Sonst weiter mit Schritt 4.
4. Prüfen, ob der Alarm innert weniger Minuten verschwindet. Wenn nicht: eskalieren.

<!-- Hinweis-Blöcke dort, wo ein Schritt die Lage verschlimmern kann: > [!WARNING] für einen riskanten Befehl, > [!CAUTION] für etwas, das Daten verliert. -->

## ZweiterAlarmName

**Alarm:** Bedingung und Schwellenwert, die ihn auslösen.

1. Erster Schritt.
2. Zweiter Schritt.

> [!WARNING]
> Was hier nicht getan werden darf, und warum.

---

# Eskalation

<!-- Wen anrufen, wenn der Ablauf nicht hilft: eine Zeile pro Bereich, eine erste und eine zweite Ansprechperson (Rollen, nicht nur Namen), die abgedeckten Zeiten und der Weg dorthin (Pager-Kennung, Telefoneintrag). -->

| Bereich | Erster Kontakt | Zweiter Kontakt | Zeiten | Wie |
|---|---|---|---|---|
| Incident-Leitung | | | 24/7 | |
| | | | | |

# Nach dem Incident

<!-- Was erledigt sein muss, bevor der Incident geschlossen wird. Nur die Punkte, die man gern vergisst. -->

- [ ] Der Incident-Kanal enthält eine Zeitleiste mit UTC-Zeitstempeln.
- [ ] Temporäre Änderungen sind mit verantwortlicher Person und Ablaufdatum aufgeführt.
- [ ] Ein Post-Incident-Review ist angesetzt.
- [ ] Der Eintrag auf der Statusseite ist abgeschlossen.

# Kurzreferenz

<!-- Nachschlagetabellen für die Nacht: wo Dashboards und Statusseiten liegen und die häufigsten Befehle, mit Platzhaltern in spitzen Klammern. -->

## Dashboards und Links

| Was | Wo |
|---|---|
| Service-Übersicht | |
| Logs | |

## Befehle

| Aufgabe | Befehl |
|---|---|
| Aktuelle Logs | `befehl <service>` |
| Zurückrollen | `befehl <service>` |
