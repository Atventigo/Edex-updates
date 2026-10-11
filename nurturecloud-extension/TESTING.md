# Testing guide (for Claude in a local session with Claude in Chrome)

You are testing a Chrome extension in the user's real browser. Read
`README.md` and `ARCHITECTURE.md` in this folder first.

## Rules (non-negotiable)

- **Read only in NurtureCloud.** Never press Send, never save or edit a
  contact, never log a call or note. If a step would change data, stop and ask.
- **The user logs in.** Never type, read back or store their password.
- **No personal data in files or chat summaries.** Report structure only:
  URL paths with ids replaced, key names, types. Never paste names, phone
  numbers or message text.
- **Backfill only with Jas's written OK** (the user will tell you). Discovery
  and demo data don't need it.
- If a HAR is exported, it goes in `.tmp/` (gitignored) and is deleted after.

## Steps the user does by hand

These need the user, because Claude can't drive them:

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → choose
   this `nurturecloud-extension` folder.
2. Log in to NurtureCloud.

## Phase 1: does it load?

1. On `chrome://extensions`, the extension shows no red "Errors" button. If it
   does, read the error and fix it.
2. Click **Details → Extension options**. The settings page opens.
3. Set **Mode = discovery**, Agent name = Jas, Save.
4. Open the service worker console (Details → "Inspect views: service
   worker") and check for errors.

## Phase 2: sidebar with demo data (no NurtureCloud data used)

1. Options → **Load demo leads**.
2. Open any NurtureCloud page. A yellow **Follow-up** panel should appear on
   the right. **If it doesn't:** note the exact domain in the address bar
   (domain only), add it to `matches` and `host_permissions` in
   `manifest.json`, reload the extension, refresh the tab.
3. Click **Today's calls**. Expected: "Alice Nguyen (demo)" and "Ben Carter
   (demo)", each with a reason and call/sms chip. Cara (texted yesterday), Dan
   (do-not-contact) and Tom (buyer) must not appear.

## Phase 3: map NurtureCloud (discovery)

Visit, without changing anything:
1. The lead/contact list: scroll, change a filter, go to page 2.
2. Two or three contacts, including one with SMS history and one with a call.
3. NurtureCloud's own call list / "Smart Calls" screen, if there is one.
4. The SMS compose screen for a contact. **Type nothing. Don't send.**

Then Options → **Refresh** → read the discovered endpoints. Work out and report:
- The lead list endpoint: path, method, auth (cookie or `Authorization`
  header), pagination param names, page size, where the array is
  (`itemsPath`), and how the end is signalled (`nextPath` or `totalPath`).
  Can one request return all ~4K leads?
- Per-contact SMS history and call history endpoints, if separate.
- **Whether NurtureCloud exposes its own scores / call-list ranking**
  (Smart Calls). If it does, we read its ranking instead of only our own.
- **The SMS send request**, from the map only: path and body keys. Don't
  trigger it. This decides the send tier: a clean POST means one-click send
  is possible; otherwise we stay with fill-the-box.
- Whether SMS threads (both directions) are visible in the web app at all.

Write this to `../clients/Jas_RayWhite/nurturecloud_endpoints.md` (structure
only), and fill the **NurtureCloud endpoints** JSON on the options page. Only
`leads.url` is required. Raw field names the mappers expect are in
`src/data/backfill.js` (`mapLead`, `mapMessage`); if NurtureCloud uses other
names, add them to the `pick(...)` lists there.

## Phase 4: SMS box

1. On the SMS compose screen, inspect the message box and find a stable CSS
   selector for it. Put it first in **SMS box selectors** on the options page.
2. Demo leads aren't real NurtureCloud contacts, so open a real contact. The
   sidebar may say it isn't synced yet; that's fine. Type
   `TEST - do not send` into the sidebar's SMS draft box.
3. Click **Put in SMS box**. Check the text appears in NurtureCloud's box and
   the Send button is enabled. **Then clear the box. Don't send.**

## Phase 5: drafts via the mock backend (optional)

Needs Python 3.11+:
```
cd ../backend
python -m venv .venv
.venv\Scripts\activate        (Windows)   |   source .venv/bin/activate
pip install fastapi uvicorn
uvicorn mock:app --port 8787
```
Options → Backend URL `http://localhost:8787`, key `dev` → Save (accept the
permission prompt). Open a real contact that has been synced, or check that
"Today's calls" still works. The mock returns canned drafts, not Claude.

## Phase 6: backfill (only with Jas's OK)

1. Options → **Clear all data** (removes demo leads).
2. Set mode **backfill**, Save. On NurtureCloud, sidebar → **Backfill all**.
   It runs about one request per second; ~4K leads can take over an hour.
   Watch the service worker console for 429s or errors.
3. Report: lead count, message count, errors. Then **Today's calls**.

## Report back

Summarise per phase: passed / failed / blocked, the fix you made if any, and
the endpoint findings (structure only). Commit code fixes to the branch
`claude/browser-extension-sms-wtsk9m`; never commit `.tmp/` or a HAR.
