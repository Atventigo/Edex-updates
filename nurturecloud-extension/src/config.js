// Defaults. Everything marked MAP comes from the endpoint mapping session
// (clients/Jas_RayWhite/nurturecloud_endpoints.md) and can be overridden on the options page.
export const DEFAULTS = {
  // n8n webhook base, e.g. https://n8n.example.com/webhook/nc
  backendUrl: "",
  backendKey: "",

  // "off": nothing leaves the browser.
  // "discovery": record endpoint shapes only (paths, key names, types). No values.
  // "capture": send full responses for matching URLs to the backend.
  mode: "discovery",

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
