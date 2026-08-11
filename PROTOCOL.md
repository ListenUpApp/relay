# Push Relay Protocol

This document specifies the wire protocol served by this relay, so that
alternative server implementations (or alternative clients) can conform to
it without reading the source. Where a section is normative only for *this*
implementation (e.g. exact FCM request shape), that's called out explicitly.

The relay exposes two endpoints: `GET /healthz` and `POST /v1/send`. Any
other path/method returns `404` with an empty body.

## `GET /healthz`

Returns `200` with:

```json
{ "ok": true }
```

No auth, no rate limiting, no body required.

## `POST /v1/send`

### Request

`Content-Type: application/json`. Body:

```json
{
  "tokens": [
    { "platform": "android", "token": "eXaMpLeFcmRegistrationToken" },
    { "platform": "ios", "token": "abc123deviceToken" }
  ],
  "payload": { "type": "book.progress.updated", "bookId": "b_123" },
  "collapseKey": "book-progress-b_123"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `tokens` | array of `{ platform: "android" \| "ios", token: string }` | yes | 1–20 entries. |
| `payload` | object | yes | Opaque — the relay never interprets it. Forwarded verbatim to the push provider. |
| `collapseKey` | string | no | Passed through to the provider's native collapse/coalescing mechanism where supported. |

### Response

`200` with one result per token, in request order:

```json
{
  "results": [
    { "token": "eXaMpLeFcmRegistrationToken", "status": "delivered" },
    { "token": "abc123deviceToken", "status": "unsupported" }
  ]
}
```

## Caps

Requests exceeding any of these caps are rejected before any provider is
contacted.

| Cap | Limit | Violation status |
|---|---|---|
| Tokens per request | 20 | `400` |
| Token length | 4096 chars | `400` |
| Serialized payload size | 3800 bytes (UTF-8) | `413` |
| `collapseKey` length | 64 chars | `400` |

All other malformed-request cases (missing/wrong-typed fields, unknown
`platform`, non-JSON body, non-object payload, empty token array) are `400`.
Only the payload-size cap is `413`.

The payload cap is set below FCM's own 4096-byte data-map limit (3800, not
4096) to leave headroom for the `"payload"` key and JSON envelope overhead
added when the relay wraps the caller's payload under
`message.data.payload` — see FCM mapping below. Without that headroom, a
payload that passes this cap could still be rejected by FCM itself with a
`400`, which the relay would otherwise map to `invalid` and wrongly cause
the caller to delete a perfectly good device token.

## HTTP statuses

| Status | When |
|---|---|
| `200` | Request accepted; body carries a per-token verdict for each token (see below). Individual tokens can still fail — a `200` does not mean every token delivered. |
| `400` | Request body isn't valid JSON, or fails validation (see Caps above and the general shape rules). |
| `413` | `payload` serializes to more than 3800 bytes. |
| `429` | Per-IP rate limit exceeded. Response has no body and a `Retry-After` header (seconds, currently a fixed `3600`). This is enforced *before* the body is parsed. |
| `404` | Unknown route or method. Empty body. |

`GET /healthz` always returns `200` with `{"ok":true}` and is not rate
limited.

## Verdict semantics

Each entry in `results` carries a `status` — one of four values. This is the
contract callers build retry/eviction logic against:

| Verdict | Meaning | Caller action |
|---|---|---|
| `delivered` | Provider accepted the message for delivery. | None. |
| `invalid` | The token is permanently unusable (unregistered, malformed, wrong sender, etc.). | **MUST** delete the token — it will never succeed. |
| `retryable` | Transient failure: could be the relay's own per-token rate limit, a provider-side rate limit or 5xx, a provider auth failure that is the *relay's* fault rather than the device token's (e.g. FCM `401`), or a transport failure reaching the provider (including OAuth token-exchange failures for FCM). | **MAY** retry once. Do not spin-retry; if it fails again, treat as an operational issue, not a token problem. |
| `unsupported` | The relay has no delivery path for this token's platform. Currently: `platform: "ios"` tokens on a deployment whose APNs secrets aren't configured. | Keep the token. Do not retry — retrying will not change the outcome until the relay deployment adds support. |

A per-token rate limit (see caps in the README) that trips mid-request
produces `retryable` for that token's entry — it does **not** fail the whole
request or change the HTTP status.

## FCM mapping (normative for this implementation)

This section describes exactly what this relay sends to Firebase Cloud
Messaging's HTTP v1 API (`https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`).
Other implementations targeting FCM should match this behavior for
consistent semantics; it is not required by the wire protocol above.

- Auth: OAuth2 access token minted from the configured service-account JSON
  via the standard `urn:ietf:params:oauth:grant-type:jwt-bearer` RS256
  assertion flow, cached in-memory for the token's lifetime.
- Messages are **data-only** — there is never a `notification` key. The
  relay does not know or care what the client renders.
- The caller's `payload` is forwarded **verbatim, serialized as a single
  JSON string**, under `message.data.payload`. It is never expanded into
  top-level `data` keys.
- `message.android.priority` is always `"HIGH"`.
- `message.android.collapse_key` is set from the request's `collapseKey`
  when provided; omitted entirely otherwise.
- Response status mapping:
  - `2xx` → `delivered`
  - `401`, `429`, or `5xx` → `retryable` (`401` means the relay's own OAuth
    token is bad — a credential blip or key rotation, not a defect in the
    device token — so it must never cause the caller to delete the token)
  - any other non-2xx (e.g. `400`, `403`, `404`) → `invalid`
  - OAuth token-exchange failure, or a network-level failure on the send
    request itself → `retryable`

## No-log conformance requirement

Implementations of this protocol **MUST NOT** persist or log:

- device tokens,
- payload contents,
- any other request-derived data (IP addresses, headers, etc. beyond what's
  strictly necessary to compute an in-memory rate-limit key for the
  duration of the process).

The only state a conforming relay may keep is **ephemeral, in-memory
rate-limit counters** (per-IP and per-token sliding windows). These counters
must not be persisted to disk or any external store, and must not be
derivable back into the tokens/IPs they were computed from beyond the
lifetime of the process.

## APNs mapping (normative for this implementation)

This section describes exactly what this relay sends to the Apple Push
Notification service provider API when APNs is configured (see the README
for the `APNS_*` secrets). When it is **not** configured, every `ios` token
returns `"unsupported"` — the pre-APNs behavior.

- Auth: token-based provider authentication — an ES256 JWT signed with the
  configured `.p8` key (`kid` = key id, `iss` = team id), cached in-memory
  for 45 minutes (inside Apple's 20–60 minute refresh window), never
  persisted.
- Host: `api.push.apple.com`, or `api.sandbox.push.apple.com` when
  `APNS_ENVIRONMENT` is `development`. One deployment serves one
  environment — sandbox device tokens are rejected by the production host.
- Request: `POST /3/device/{token}` with headers `apns-topic` (the
  configured bundle id), `apns-push-type: alert`, `apns-priority: 10`, and
  `apns-collapse-id` from the request's `collapseKey` when provided.
- Body: the `aps` envelope carries **no composed text** — only constant
  localization keys (`title-loc-key` / `loc-key`, configurable, default
  `push.generic_title` / `push.generic_body`) and `mutable-content: 1`. The
  caller's `payload` is forwarded **verbatim, serialized as a single JSON
  string**, under a top-level `payload` key — mirroring the FCM
  `message.data.payload` mapping. The app's notification service extension
  decodes and enriches locally; if it never runs, iOS renders the app's own
  localized generic strings. The relay still never composes UI text.
- Response status mapping:
  - `200` → `delivered`
  - `403` → `retryable` (Invalid/ExpiredProviderToken — the relay's own
    credential, never the device token's fault; the cached provider token is
    dropped so the next send re-signs)
  - `429` or `5xx` → `retryable`
  - any other non-2xx (`400` BadDeviceToken et al., `404`, `410`
    Unregistered) → `invalid`
  - provider-token signing failure → `retryable`; a network-level failure on
    the send itself → `retryable`

## Future / reserved
- **`ttl` field.** Not part of the current request shape. A future revision
  may add an optional `ttl` (seconds) field to bound how long a provider
  should hold an undeliverable message. Until it exists, providers use
  their own defaults.
