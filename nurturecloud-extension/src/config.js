// Defaults. Everything marked MAP comes from the endpoint mapping session
// (clients/Jas_RayWhite/nurturecloud_endpoints.md) and can be overridden on the options page.
export const DEFAULTS = {
  // n8n webhook base, e.g. https://n8n.example.com/webhook/nc
  backendUrl: "",
  backendKey: "",

  // "off": nothing leaves the browser.
  // "discovery": record endpoint shapes only (paths, key names, types). No values.
  // "capture": passively ingest responses into the local store as the agent browses.
  // "backfill": actively paginate all leads + history into the local store (one-time).
  mode: "discovery",

  // The agent's name, woven into every SMS draft so the sender is identified.
  agentName: "Jas",
  // How many leads the daily call list shows.
  callListLimit: 25,
  // NurtureCloud fetch endpoints for backfill/sync. Filled from the discovery/HAR
  // session; see src/data/endpoints.example.js for the shape and placeholders.
  endpoints: null,

  // MAP: regexes (strings) of response URLs worth capturing. Empty = every JSON response.
  captureUrlPatterns: [],
  // MAP: never capture these (auth, telemetry).
  ignoreUrlPatterns: ["/auth", "/token", "/login", "sentry", "segment", "analytics", "intercom"],
  // Responses larger than this are skipped.
  maxBodyBytes: 5_000_000,

  // MAP: how to find the contact id in the page URL. First capture group = id.
  contactUrlPattern: "/contacts?/([A-Za-z0-9_-]+)",
  // MAP: NurtureCloud's SMS compose box. First match wins.
  smsBoxSelectors: [
    "textarea[name*='sms' i]",
    "textarea[placeholder*='message' i]",
    "[contenteditable='true'][aria-label*='message' i]",
    "textarea"
  ],

  // Spam Act 2003: a commercial SMS must identify the sender and offer an unsubscribe.
  requiredSmsPhrases: ["Jas"],
  optOutPattern: "\\b(STOP|opt out|unsubscribe)\\b"
};
