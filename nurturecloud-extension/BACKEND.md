# Backend contract (n8n)

The extension posts to a configurable base URL (the n8n webhook base) with an
`X-Extension-Key` header. Three endpoints. All bodies are JSON.

## `POST /capture`

Sent once per matching NurtureCloud JSON response, in capture mode.

```json
{
  "source": "nurturecloud",
  "capturedAt": "2026-10-11T04:00:00.000Z",
  "endpoint": "GET app.nurturecloud.com/api/contacts/:id/notes?page",
  "url": "https://app.nurturecloud.com/api/contacts/8f3a.../notes?page=1",
  "status": 200,
  "body": { }
}
```

`endpoint` is the id-stripped template (good for grouping/storage keys); `body`
is the raw response. The backend normalises contacts, messages and call logs
into its database and merges them with VaultRE events. Respond `200` with an
empty body.

## `POST /suggest`

Asked when the sidebar opens a contact, or when "New draft" is pressed.

Request:

```json
{ "contactId": "8f3a...", "regenerate": false, "pageUrl": "https://app.nurturecloud.com/contacts/8f3a..." }
```

Response (all fields optional strings; the sidebar renders what it gets):

```json
{
  "contactName": "Sam",
  "lastContacted": "SMS 12 days ago",
  "nextAction": "Call — no answer to last 2 SMS",
  "talkingPoint": "A 3-bed on their street sold last week above expectation",
  "smsDraft": "Hi Sam, Jas from Ray White. ... Reply STOP to opt out.",
  "reason": "No reply in 12 days and a comparable sale nearby"
}
```

The LLM that writes `smsDraft` should already satisfy the Spam Act checks the
extension runs (`src/sms.js`): name the sender and include an opt-out. The
extension re-checks and shows warnings, but does not block.

## `POST /drafted`

Fired when the agent clicks "Put in SMS box" (not when the SMS is actually
sent — the real send is captured later from NurtureCloud's own history).

```json
{ "contactId": "8f3a...", "at": "2026-10-11T04:05:00.000Z" }
```

Respond `200`. Use it to suppress re-suggesting the same contact for a while.

## Notes for the n8n side

- VaultRE listing/sale events come in via the VaultRE REST API (see handoff),
  not through this extension. Join them to contacts on phone/email.
- Rate: capture fires per response, so debounce/batch writes downstream.
- Auth is a shared key only. Put the webhook behind HTTPS and rotate the key if
  it leaks; it is stored in the extension's local storage.
