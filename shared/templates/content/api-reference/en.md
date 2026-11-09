<!-- An API reference: lookup material, read by developers who search for one endpoint. The title block prints the title, the API version (subtitle) and the date. Structure: general sections first, then one H1 per resource, one H2 per endpoint with its method and path in an ```http block, H3 Parameters / Request / Response, and one H4 per status code ("200 OK"). -->

[[toc]]

# Overview

<!-- Two or three sentences on what the API does and its conventions: request and response format, how amounts, timestamps and IDs are written. Then the base URL. {{description}} -->

```text
https://api.example.com/v1
```

# Authentication

<!-- How to authenticate (header and scheme), where keys are created, and the kinds of key with what each may do. Show one complete request. Warn where a key must never go. Add H2s for versioning and idempotency if the API has them. -->

```bash
curl https://api.example.com/v1/items \
  -H "Authorization: Bearer $API_KEY"
```

| Key prefix | Mode | Typical use |
|---|---|---|
| `test_` | Test | Development, CI |
| `live_` | Live | Production servers |

> [!WARNING]
> Secret keys must never reach a browser or a mobile app.

# Errors

<!-- The shape of an error body, then one row per status code: the error type, the common machine-readable codes, and whether a client should retry. -->

```json
{
  "error": {
    "type": "invalid_request",
    "code": "parameter_invalid",
    "message": "Human-readable explanation.",
    "request_id": "req_123"
  }
}
```

| Status | `type` | Common `code` values | Retry? |
|---|---|---|---|
| 400 | `invalid_request` | | No |
| 401 | `authentication` | | No |
| 404 | `invalid_request` | | No |
| 429 | `rate_limit` | | Yes, after `Retry-After` |
| 500 | `api_error` | | Yes |

# Rate limits

<!-- Limits per scope, the headers that report them, and how a client should back off when it hits one. -->

| Scope | Limit | Window |
|---|---|---|
| Per account | | |

# Items

<!-- One H1 per resource, named in the plural as in the path. Open with one or two sentences on what the resource represents and its lifecycle. Copy this block for each further resource. -->

## The item object

<!-- Every field of the object: name in backticks, type, and what it means, including units, allowed values and when it is null. -->

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier. |
| `created` | string | When the item was created. |

## Create an item

```http
POST /items
```

<!-- One sentence on what the endpoint does and any side effect. -->

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | |

### Request

```bash
curl https://api.example.com/v1/items \
  -H "Authorization: Bearer $API_KEY" \
  -d name=example
```

### Response

#### 200 OK

```json
{
  "id": "item_123",
  "name": "example",
  "created": "YYYY-MM-DDThh:mm:ssZ"
}
```

#### 400 Bad Request

<!-- When this status occurs for this endpoint, with the error codes that apply. -->

## Retrieve an item

```http
GET /items/{id}
```

### Parameters

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | The item ID. |

### Response

#### 200 OK

Returns the [item object](#the-item-object).

#### 404 Not Found

<!-- When this status occurs, e.g. an unknown ID or one that belongs to another account. -->
