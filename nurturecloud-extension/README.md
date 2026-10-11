# Follow-up Assistant for NurtureCloud

A Chrome (Manifest V3) extension that helps a Ray White agent follow up with
leads inside NurtureCloud, which has no public API. It mirrors the decisions in
`clients/Jas_RayWhite/HANDOFF.md`:

- **Reads** the data NurtureCloud already loads, by wrapping `fetch`/`XHR` in
  the page, while the agent works normally.
- **Assists** with a sidebar on each contact: last contact, suggested next
  action, a talking point and a draft SMS. It fills NurtureCloud's own SMS box.
  **The agent presses send.** Nothing is sent automatically.

It does not log in, store a password, or scrape in the background. It only sees
what the agent's own session loads.

## The three modes

Set on the options page. Start at the top and only move down with Jas's OK.

| Mode | What leaves the browser | Use |
|---|---|---|
| **off** | Nothing. | Default / paused. |
| **discovery** | Nothing. Records endpoint *structure* only (paths with ids stripped, key names and types) in local storage. | The mapping step in the handoff. Export the JSON and paste it into `nurturecloud_endpoints.md`. No names, numbers or message text are ever recorded — see `src/shape.js` and its tests. |
| **capture** | Full matching JSON responses are sent to the backend, and the sidebar shows suggestions. | Only after Jas agrees in writing, per the handoff. |

## Install (unpacked, for development)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   folder.
2. Open the extension's **options** and set the mode. For capture mode also set
   the backend URL and key.
3. Reload any open NurtureCloud tab.

## Mapping NurtureCloud (discovery mode)

1. Options → mode **discovery** → Save.
2. In NurtureCloud, visit the screens from the handoff's "Next step": lead list
   (scroll/filter), a few contacts incl. one with SMS and one with call
   history, call lists, and the SMS compose screen (**don't send**).
3. Back on the options page → **Refresh**, then **Download JSON**.
4. Paste the structure into `clients/Jas_RayWhite/nurturecloud_endpoints.md`.
   It holds no personal data by construction, so it is safe to commit — unlike a
   HAR export, which is not.

The options page also lets you set `captureUrlPatterns`, `contactUrlPattern`
(how the contact id appears in the page URL) and `smsBoxSelectors` once mapping
shows NurtureCloud's real paths and markup — nothing here is hard-coded to
guessed endpoints.

## Backend

The extension is deliberately thin. Merging VaultRE listing/sale events,
deciding who to contact next, and writing drafts with an LLM all live in the
n8n backend. The HTTP contract the extension expects is in `BACKEND.md`.

## Tests

`npm test` (Node's built-in runner) covers the two pure modules: `shape.js`
(proves discovery mode cannot leak values) and `sms.js` (Spam Act checks and
segment counting). The Chrome-dependent scripts are integration-tested by hand
in the browser.

## Privacy & safety

- Discovery records structure only; capture is off until explicitly enabled.
- HAR files and captured data contain personal data and live sessions — keep
  them in `.tmp/`, never commit them (see handoff rules).
- Every outbound destination (backend origin) is an optional host permission
  the user grants on the options page, not a blanket content-script grant.
- SMS stays manual: the extension fills the box; the agent reviews and sends.
  Compliance with Australia's Spam Act 2003 (sender identified, opt-out
  present) is checked on the draft but remains the agent's responsibility.
