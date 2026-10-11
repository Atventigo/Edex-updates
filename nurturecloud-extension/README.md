# Follow-up Assistant for NurtureCloud

A Chrome (Manifest V3) extension that tells a Ray White agent who to call
today, who to leave alone, and what to text, using the leads already in
NurtureCloud. NurtureCloud has no public API, so the extension works inside the
agent's own logged-in session.

SMS goes out from NurtureCloud itself, from the number the lead already knows,
and the history stays in NurtureCloud. The extension writes the draft and
puts it in NurtureCloud's SMS box; the agent presses Send. GoHighLevel is a
fallback only if NurtureCloud turns out to block this.

How the pieces fit is in `ARCHITECTURE.md`. The backend routes are in
`BACKEND.md`.

## What the agent sees

A sidebar on NurtureCloud:

- **Today's calls**: every synced lead scored and ranked, top N shown with
  priority, the main reason, and whether to call or text.
- **On a contact**: last contact, next action, a talking point for the call,
  and an SMS draft with compliance warnings. "Put in SMS box" fills
  NurtureCloud's own box.
- **Backfill all / Sync now**: pull every lead and its history into the
  extension, or just what changed since the last sync.

## Modes

Set on the options page. Move down the list only with Jas's OK.

| Mode | What it does |
|---|---|
| **off** | Nothing. |
| **discovery** | Records endpoint structure only (paths with ids stripped, key names and types). No values, nothing uploaded. Used to map NurtureCloud. |
| **capture** | Same recording while the agent browses; data reaches the local store through backfill/sync. |
| **backfill** | Enables pulling all leads + history into the local store. |

Lead data stays in the browser (IndexedDB). The backend only sees what it needs
to draft one message, plus a suburb and street for VaultRE lookups.

## Install (unpacked)

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Options: set the mode, agent name, and (optionally) the backend URL and key.
3. Reload any open NurtureCloud tab.

## Mapping NurtureCloud

Backfill and sync can't run until NurtureCloud's real endpoints are known.

1. Options → mode **discovery** → Save.
2. In NurtureCloud, open the lead list (scroll, filter), two or three contacts
   including one with SMS history and one with call history, call lists, and
   the SMS compose screen. Don't send anything.
3. Options → **Refresh** → **Download JSON**. That file holds structure only.
4. From it (or from a HAR export), fill the **NurtureCloud endpoints** JSON on
   the options page. Only `leads.url` is required; the rest is skipped while
   it says TODO.

A HAR export contains personal data and live session tokens. Keep it in
`.tmp/`, never commit it, and delete it after mapping.

## Tests

`npm test` runs the unit tests (sms checks, structure-only shapes, scoring,
data layer). The backend's tests: `python3 ../backend/tests/test_core.py`.

## Safety

- The agent sends every SMS. Nothing is sent automatically.
- Drafts are checked for the Spam Act basics (sender named, opt-out present)
  and kept to one SMS segment.
- Backfill is throttled to about one request a second and backs off on rate
  limits, because the account at risk is the agent's.
