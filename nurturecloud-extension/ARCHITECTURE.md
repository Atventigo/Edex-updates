# Architecture & interface contract

Follow-up assistant for NurtureCloud. **NurtureCloud-first**: send from the
number the lead already knows, keep history in NurtureCloud. GoHighLevel is a
fallback only if NurtureCloud blocks reading threads or sending.

## Where things run

```
  EXTENSION (does most of the work)              THIN BACKEND (Modal.com)
  ────────────────────────────────              ────────────────────────
  - captures NurtureCloud responses              - POST /draft   (Claude API)
  - active backfill of all leads + history       - POST /vault-events (VaultRE)
  - daily delta sync                             only these two, because each
  - IndexedDB holds all lead data locally        needs a secret key that must
  - scoring brain runs client-side               NOT live in a browser.
  - sidebar: daily call list + per-lead draft    Stateless. Auth: X-Extension-Key.
  - fills / sends SMS inside NurtureCloud
```

Lead data and message bodies stay in the browser. The backend only ever sees
the minimal context needed to draft one message, plus a suburb/street to look
up VaultRE events.

## Send tiers (highest that works, decided after endpoint discovery)

1. **Click & send** via NurtureCloud's own send endpoint (needs a usable endpoint).
2. **Fill-the-box** — fill NurtureCloud's SMS box, agent presses Send (always works).
3. **GoHighLevel** fallback — only if NurtureCloud won't allow 1 or 2.

## Endpoints are NOT known yet

Real NurtureCloud URLs/pagination come from a discovery run / HAR. All
NurtureCloud calls are driven by an injected `endpoints` config, never
hardcoded. Ship `src/data/endpoints.example.js` with TODO placeholders.

NurtureCloud auth: cookies are sent automatically from the content-script
context; if a bearer token is also required, it is captured from an observed
request (the page hook already sees request headers) and passed as
`authHeaders`. Backfill/sync therefore run from the content script, not the
service worker.

---

## Data model (IndexedDB, database `fua`)

Store `leads` (keyPath `id`):
```
{ id, name, firstName, phone, stage, owner, suburb, street, address,
  lastContactedAt, lastContactChannel, lastInboundAt,
  smsCount, callCount, responded, doNotContact, tags:[], updatedAt }
```
Store `messages` (keyPath `id`, index `contactId`):
```
{ id, contactId, direction:'in'|'out', channel:'sms'|'call'|'email',
  at, segments, bodyPreview }   // bodies stay local, never uploaded
```
Store `scores` (keyPath `contactId`):
```
{ contactId, priority, bucket, reasons:[], suggestedChannel, nextActionAt, computedAt }
```
Store `meta` (keyPath `key`): sync cursors, backfill progress.

## Scoring module API — `src/scoring/score.js` (pure, no I/O)
```
scoreLead(lead, messages, vaultEvents, now) ->
  { priority: 0..100, bucket:'call_today'|'nurture'|'skip',
    reasons: string[], suggestedChannel:'sms'|'call', nextActionAt: ISO|null }
rankLeads(scored[]) -> scored[] sorted priority desc
dailyCallList(scored[], limit) -> scored[]   // top call_today, capped
```
Deterministic heuristics (document each in `reasons`): never-contacted seller →
high; awaiting our reply after an inbound → high; contacted < 2 days ago → skip
(too soon); VaultRE listing/sale on their street in last 14 days → boost;
`doNotContact` → skip; long silence (30–90d) on a warm lead → nurture/call.

## Extension data layer API — `src/data/`
`store.js`: `openDB()`, `upsertLeads(rows)`, `upsertMessages(rows)`,
`getLead(id)`, `getMessages(contactId)`, `allLeads()`, `saveScores(rows)`,
`getMeta(key)`, `setMeta(key,val)`. Wrap all IndexedDB in promises; tolerate
private-mode failures.
`backfill.js`: `runBackfill({ endpoints, authHeaders, fetchJson, onProgress, throttleMs=1000, signal })`
— paginate leads, then per-contact messages/calls, map to the data model, write
to the store, report progress. Throttle ~1 req/s; back off on 429.
`sync.js`: `runDelta({ endpoints, authHeaders, fetchJson, since })` — pull
records changed since the last cursor.

## Backend API — `backend/`
`POST /draft` → body `{ lead:{firstName,suburb,stage,lastContactSummary}, reason, context? }`
returns `{ sms, talkingPoint }`. The SMS must: be one GSM segment (≤160 chars,
no emoji), name the sender, include an opt-out. Uses the Claude API
(current model id; see the claude-api skill).
`POST /vault-events` → body `{ suburb, street, contactAddress }` returns
`{ events:[{ type:'listed'|'sold', address, date, price? }] }`. Uses the VaultRE
REST API (base `https://ap-southeast-2.api.vaultre.com.au/api/v1.3/`,
`X-Api-Key` + `Authorization: Bearer`). Respect 10 req/s, 10k/day.
Auth on both: `X-Extension-Key` header. Secrets via Modal secrets
(`ANTHROPIC_API_KEY`, `VAULTRE_API_KEY`, `VAULTRE_TOKEN`, `EXTENSION_KEY`).
Must run and be testable locally without real keys (mock mode).
