<!--
  Fixture: api-reference — template "API reference" (Engineering).
  Stresses: deep heading hierarchy (h1 resource → h2 endpoint with method +
  path as an ```http fence → h3 Parameters/Request/Response → h4 per status code);
  many parameter tables (some with long description cells and inline code);
  request/response JSON blocks (one > 15 lines, so it splits); curl blocks with
  long lines; an error-code table; auth + rate-limit sections; note/warning
  alerts; [[toc]] with depth.
  Suggested title: "Larkspur Payments API v2 — Reference". Patch: api-reference-patch.json.
-->

[[toc]]

# Introduction

The Larkspur Payments API is organised around REST. It accepts JSON request bodies, returns JSON responses, and uses standard HTTP verbs and status codes. All requests are made to:

```text
https://api.larkspur.example/v2
```

Amounts are integers in the smallest currency unit (cents for EUR, rappen for CHF). Timestamps are RFC 3339 strings in UTC. IDs are opaque strings with a type prefix, for example `pay_8Kx2RmQe41` for a payment.

# Authentication

Authenticate with a secret API key in the `Authorization` header. Keys are created in the dashboard under **Developers → API keys** and are scoped to one account and one mode (test or live).

```bash
curl https://api.larkspur.example/v2/payments \
  -H "Authorization: Bearer $LARKSPUR_API_KEY" \
  -H "Larkspur-Version: 2026-09-01"
```

| Key prefix | Mode | Can move money | Typical use |
|---|---|---|---|
| `sk_test_` | Test | No | Development, CI |
| `sk_live_` | Live | Yes | Production servers |
| `rk_live_` | Live, restricted | Only the scopes you grant | Back-office tools, analytics |

> [!WARNING]
> Secret keys must never reach a browser or a mobile app. Use publishable keys (`pk_…`) with Larkspur Elements on the client side.

## Versioning

Send a `Larkspur-Version` header to pin the API version. Without it, requests use the version that was current when the key was created. Breaking changes are only released in a new dated version; additive changes (new fields, new optional parameters, new event types) can appear at any time, so ignore fields you do not know.

## Idempotency

`POST` requests accept an `Idempotency-Key` header (up to 255 characters). A repeated request with the same key and the same body within 24 hours returns the original response without performing the operation again. A repeated key with a **different** body returns `409 idempotency_key_reused`.

# Rate limits

| Scope | Limit | Burst | Window |
|---|---|---|---|
| Live mode, per account | 100 requests/s | 200 | sliding 1 s |
| Test mode, per account | 25 requests/s | 50 | sliding 1 s |
| `POST /payments`, per card fingerprint | 10 requests | — | 1 min |
| `GET /reports/*` | 5 requests | — | 1 min |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. Requests over the limit get `429 rate_limited` with a `Retry-After` header in seconds. Back off with jitter; retrying immediately extends the window.

# Errors

Errors use conventional HTTP status codes and a JSON body with a stable machine-readable `code`:

```json
{
  "error": {
    "type": "invalid_request",
    "code": "parameter_invalid",
    "message": "amount must be a positive integer",
    "param": "amount",
    "request_id": "req_2fJ8sKq0Lm"
  }
}
```

| Status | `type` | Common `code` values | Retry? |
|---|---|---|---|
| 400 | `invalid_request` | `parameter_missing`, `parameter_invalid`, `currency_unsupported` | No — fix the request |
| 401 | `authentication` | `key_missing`, `key_invalid`, `key_expired` | No |
| 402 | `card_error` | `card_declined`, `insufficient_funds`, `expired_card`, `authentication_required` | No — ask the customer |
| 403 | `permission` | `scope_missing`, `account_restricted` | No |
| 404 | `invalid_request` | `resource_missing` | No |
| 409 | `conflict` | `idempotency_key_reused`, `payment_already_captured` | No |
| 422 | `invalid_request` | `amount_too_large`, `refund_exceeds_payment` | No |
| 429 | `rate_limit` | `rate_limited` | Yes, after `Retry-After` |
| 500, 502, 503 | `api_error` | `internal`, `upstream_unavailable` | Yes, with the same idempotency key |

# Payments

A **payment** represents one attempt to collect money from a customer. Payments are created, optionally authorised first and captured later, and can be refunded in whole or in part.

## The payment object

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier, prefix `pay_`. |
| `amount` | integer | Amount to collect, in the smallest currency unit. |
| `amount_captured` | integer | Amount captured so far. |
| `amount_refunded` | integer | Amount refunded so far. |
| `currency` | string | ISO 4217 code, lowercase (`eur`, `chf`, `gbp`). |
| `status` | enum | `requires_action`, `authorized`, `captured`, `failed`, `canceled`. |
| `capture_method` | enum | `automatic` (default) or `manual`. Manual payments must be captured within 7 days or they are released. |
| `customer` | string \| null | ID of the customer, if any. |
| `payment_method` | object | Card, SEPA debit or TWINT details; never contains the full card number. |
| `metadata` | object | Up to 50 string key/value pairs you can use for your own references. |
| `created` | string | When the payment was created. |

## Create a payment

```http
POST /payments
```

Creates a payment and, with `capture_method=automatic`, attempts to charge the payment method immediately.

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `amount` | integer | yes | Positive integer, at least 50 for EUR and CHF. |
| `currency` | string | yes | Three-letter ISO code, lowercase. |
| `payment_method` | string | yes | ID of a payment method (`pm_…`) collected with Elements. |
| `customer` | string | no | Attach the payment to a customer. Required to save the payment method for later. |
| `capture_method` | enum | no | `automatic` or `manual`. |
| `description` | string | no | Shown in the dashboard and in receipt e-mails. Up to 500 characters. |
| `statement_descriptor_suffix` | string | no | Appended to your account's statement descriptor on the cardholder's bank statement; 1–12 Latin characters, no `<`, `>`, `\`, `'` or `"`. |
| `return_url` | string | conditional | Where to send the customer after 3-D Secure. Required when the payment method may need authentication. |
| `metadata` | object | no | Your own key/value pairs. |

### Request

```bash
curl https://api.larkspur.example/v2/payments \
  -H "Authorization: Bearer $LARKSPUR_API_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d amount=4990 -d currency=eur -d payment_method=pm_1Lq8ZtV2 -d customer=cus_9QxL2 \
  -d "metadata[order_id]=58213" -d return_url=https://shop.example/checkout/return
```

### Response

#### 200 OK

```json
{
  "id": "pay_8Kx2RmQe41",
  "object": "payment",
  "amount": 4990,
  "amount_captured": 4990,
  "amount_refunded": 0,
  "currency": "eur",
  "status": "captured",
  "capture_method": "automatic",
  "customer": "cus_9QxL2",
  "description": null,
  "payment_method": {
    "id": "pm_1Lq8ZtV2",
    "type": "card",
    "card": {
      "brand": "visa",
      "last4": "4242",
      "exp_month": 8,
      "exp_year": 2029,
      "country": "CH",
      "three_d_secure": { "result": "authenticated", "version": "2.2.0" }
    }
  },
  "metadata": { "order_id": "58213" },
  "created": "2026-11-04T10:21:07Z"
}
```

#### 402 Payment Required

```json
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "do_not_honor",
    "message": "The card was declined.",
    "payment": "pay_8Kx2RmQe41",
    "request_id": "req_7hS0dLq2Pz"
  }
}
```

> [!NOTE]
> A declined payment is still created and has `status: "failed"`. Retry with a different payment method by creating a **new** payment; failed payments cannot be retried.

## Retrieve a payment

```http
GET /payments/{id}
```

### Parameters

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | The payment ID. |
| `expand[]` | query | string | Inline related objects: `customer`, `refunds`. |

### Response

#### 200 OK

Returns the [payment object](#the-payment-object).

#### 404 Not Found

Returned when the ID does not exist **or** belongs to another account; the two cases are indistinguishable on purpose.

## List payments

```http
GET /payments
```

Returns payments sorted by creation date, newest first. Results are paginated with cursors.

### Parameters

| Name | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | 20 | 1–100. |
| `starting_after` | string | — | Cursor: the ID of the last object on the previous page. |
| `created[gte]`, `created[lt]` | string | — | Filter by creation time. |
| `status` | enum | — | Filter by status. |
| `customer` | string | — | Filter by customer. |

### Response

#### 200 OK

```json
{
  "object": "list",
  "data": [{ "id": "pay_8Kx2RmQe41", "amount": 4990, "status": "captured" }],
  "has_more": true,
  "next_cursor": "pay_8Kx2RmQe41"
}
```

# Refunds

## Create a refund

```http
POST /refunds
```

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `payment` | string | yes | The payment to refund. |
| `amount` | integer | no | Defaults to the remaining refundable amount. |
| `reason` | enum | no | `duplicate`, `fraudulent`, `requested_by_customer`. |

### Response

#### 200 OK

```json
{
  "id": "re_3Nf0aPq7",
  "object": "refund",
  "payment": "pay_8Kx2RmQe41",
  "amount": 1500,
  "status": "pending",
  "reason": "requested_by_customer",
  "created": "2026-11-05T08:02:44Z"
}
```

#### 422 Unprocessable Entity

`refund_exceeds_payment` — the amount is larger than what remains refundable.

# Webhooks

Larkspur sends events to the HTTPS endpoints you register. Each request is signed; verify the `Larkspur-Signature` header before trusting the body.

## Event types

| Event | Sent when |
|---|---|
| `payment.captured` | A payment was captured (automatic or manual). |
| `payment.failed` | An attempt failed; the body includes the decline code. |
| `refund.succeeded` | The refund reached the customer's bank. |
| `dispute.created` | The cardholder disputed a payment. Respond within 7 days. |

## Verify the `Larkspur-Signature` header

The header holds a timestamp `t` and an HMAC-SHA256 signature `v1` of `{t}.{body}`, keyed with the endpoint's signing secret. Reject requests older than five minutes to stop replays.

```python
import hmac, hashlib, time

def verify(payload: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(item.split("=", 1) for item in header.split(","))
    timestamp, signature = int(parts["t"]), parts["v1"]
    if abs(time.time() - timestamp) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```
