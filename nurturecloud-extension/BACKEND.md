# Backend contract

The backend is a thin, stateless Modal service in `../backend/`. It holds no
lead data. The extension calls it for only two things, because each needs a
secret key that must not live in the browser. Setup and deploy steps are in
`../backend/README.md`.

Both routes are `POST`, take and return JSON, and require the header
`X-Extension-Key` (set on the extension's options page). The base URL is the
Modal endpoint URL, also set on the options page. With no backend URL set, the
extension still scores leads and builds the call list; it just shows no drafts
or VaultRE reasons.

## `POST /draft`

Asks Claude to write one suggested SMS and a one-line call opener.

```json
{
  "lead": { "firstName": "Sam", "suburb": "Paddington", "stage": "seller",
            "lastContactSummary": "Last contacted 12/09/2026 by sms." },
  "reason": "Seller lead, never contacted",
  "context": { "agentName": "Jas", "suggestedChannel": "call" }
}
```

Returns `{ "sms": "...", "talkingPoint": "..." }`. The SMS is cleaned to one
GSM segment (160 characters, no emoji), names the sender, and ends with
"Reply STOP to opt out". The extension re-checks it before filling the box.

## `POST /vault-events`

Looks up recent VaultRE listings and sales near a contact.

```json
{ "suburb": "Paddington", "street": "Latrobe Tce", "contactAddress": "12 Latrobe Tce" }
```

Returns `{ "events": [{ "type": "listed" | "sold", "address": "...", "date": "...", "price": 0 }] }`.
The extension caches results per suburb for 6 hours. On a VaultRE rate limit
the backend returns an empty list rather than an error.

## Developing without keys

`backend/mock.py` serves both routes with fake data. Point the extension's
backend URL at it (`http://localhost:8787`) to exercise the sidebar end to end.
