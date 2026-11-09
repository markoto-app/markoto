<!-- Eine API-Referenz: Nachschlagematerial für Entwicklerinnen und Entwickler, die einen bestimmten Endpunkt suchen. Der Titelblock zeigt Titel, API-Version (Untertitel) und Datum. Aufbau: zuerst die allgemeinen Abschnitte, dann ein H1 pro Ressource, ein H2 pro Endpunkt mit Methode und Pfad in einem ```http-Block, H3 Parameter / Anfrage / Antwort und ein H4 pro Statuscode („200 OK“). -->

[[toc]]

# Überblick

<!-- Zwei, drei Sätze dazu, was die API tut, und zu ihren Konventionen: Format von Anfrage und Antwort, wie Beträge, Zeitstempel und IDs geschrieben werden. Danach die Basis-URL. {{description}} -->

```text
https://api.example.com/v1
```

# Authentifizierung

<!-- Wie man sich authentifiziert (Header und Verfahren), wo Schlüssel erstellt werden und welche Arten von Schlüsseln es gibt und was sie dürfen. Zeigen Sie eine vollständige Anfrage. Warnen Sie, wo ein Schlüssel nie hingehört. Ergänzen Sie H2 für Versionierung und Idempotenz, falls die API sie kennt. -->

```bash
curl https://api.example.com/v1/items \
  -H "Authorization: Bearer $API_KEY"
```

| Schlüssel-Präfix | Modus | Typische Verwendung |
|---|---|---|
| `test_` | Test | Entwicklung, CI |
| `live_` | Live | Produktionsserver |

> [!WARNING]
> Geheime Schlüssel dürfen nie in einen Browser oder eine mobile App gelangen.

# Fehler

<!-- Der Aufbau einer Fehlerantwort, dann eine Zeile pro Statuscode: Fehlertyp, die häufigen maschinenlesbaren Codes und ob ein Client es erneut versuchen soll. -->

```json
{
  "error": {
    "type": "invalid_request",
    "code": "parameter_invalid",
    "message": "Verständliche Erklärung.",
    "request_id": "req_123"
  }
}
```

| Status | `type` | Häufige `code`-Werte | Wiederholen? |
|---|---|---|---|
| 400 | `invalid_request` | | Nein |
| 401 | `authentication` | | Nein |
| 404 | `invalid_request` | | Nein |
| 429 | `rate_limit` | | Ja, nach `Retry-After` |
| 500 | `api_error` | | Ja |

# Rate-Limits

<!-- Die Limits pro Geltungsbereich, die Header, die sie melden, und wie ein Client zurückweichen soll, wenn er an ein Limit stösst. -->

| Geltungsbereich | Limit | Zeitfenster |
|---|---|---|
| Pro Konto | | |

# Items

<!-- Ein H1 pro Ressource, im Plural benannt wie im Pfad. Beginnen Sie mit ein, zwei Sätzen dazu, was die Ressource darstellt und wie ihr Lebenszyklus aussieht. Kopieren Sie diesen Block für jede weitere Ressource. -->

## Das Item-Objekt

<!-- Jedes Feld des Objekts: Name in Backticks, Typ und Bedeutung, mit Einheiten, erlaubten Werten und wann es null ist. -->

| Feld | Typ | Beschreibung |
|---|---|---|
| `id` | string | Eindeutige Kennung. |
| `created` | string | Zeitpunkt der Erstellung. |

## Item anlegen

```http
POST /items
```

<!-- Ein Satz dazu, was der Endpunkt tut, und zu allfälligen Nebenwirkungen. -->

### Parameter

| Name | Typ | Pflicht | Beschreibung |
|---|---|---|---|
| `name` | string | ja | |

### Anfrage

```bash
curl https://api.example.com/v1/items \
  -H "Authorization: Bearer $API_KEY" \
  -d name=beispiel
```

### Antwort

#### 200 OK

```json
{
  "id": "item_123",
  "name": "beispiel",
  "created": "JJJJ-MM-TTThh:mm:ssZ"
}
```

#### 400 Bad Request

<!-- Wann dieser Status bei diesem Endpunkt auftritt, mit den zutreffenden Fehlercodes. -->

## Item abrufen

```http
GET /items/{id}
```

### Parameter

| Name | Ort | Typ | Beschreibung |
|---|---|---|---|
| `id` | path | string | Die ID des Items. |

### Antwort

#### 200 OK

Gibt das [Item-Objekt](#das-item-objekt) zurück.

#### 404 Not Found

<!-- Wann dieser Status auftritt, z. B. bei einer unbekannten ID oder einer, die zu einem anderen Konto gehört. -->
