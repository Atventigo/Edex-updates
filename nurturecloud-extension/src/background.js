import { DEFAULTS } from "./config.js";
import { shapeOf, mergeShapes, templatePath } from "./shape.js";
import { checkDraft } from "./sms.js";

async function getConfig() {
  const stored = await chrome.storage.local.get("config");
  return { ...DEFAULTS, ...(stored.config || {}) };
}

const matchesAny = (url, patterns) => patterns.some((p) => {
  try {
    return new RegExp(p, "i").test(url);
  } catch {
    return false;
  }
});

function shouldCapture(url, config) {
  if (matchesAny(url, config.ignoreUrlPatterns)) return false;
  return config.captureUrlPatterns.length === 0 || matchesAny(url, config.captureUrlPatterns);
}

// Discovery mode keeps an in-memory endpoint map, saved at most once a second.
let endpoints;
let saveTimer;
async function recordShape({ url, method, status, body }) {
  if (!endpoints) endpoints = (await chrome.storage.local.get("endpoints")).endpoints || {};
  const key = `${method} ${templatePath(url)}`;
  const now = new Date().toISOString();
  const entry = endpoints[key] || { count: 0, statuses: [], firstSeen: now };
  entry.count += 1;
  entry.lastSeen = now;
  if (!entry.statuses.includes(status)) entry.statuses.push(status);
  entry.shape = mergeShapes(entry.shape, shapeOf(body));
  if (Array.isArray(body)) entry.maxItems = Math.max(entry.maxItems || 0, body.length);
  endpoints[key] = entry;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ endpoints }), 1000);
}

async function backend(path, payload, config) {
  if (!config.backendUrl) throw new Error("Backend URL not set (extension options).");
  const res = await fetch(config.backendUrl.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Extension-Key": config.backendKey },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Backend ${path} returned ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function handle(msg) {
  const config = await getConfig();
  switch (msg.type) {
    case "getConfig":
      return config;

    case "capture": {
      if (config.mode === "off" || !shouldCapture(msg.url, config)) return;
      if (JSON.stringify(msg.body).length > config.maxBodyBytes) return;
      if (config.mode === "discovery") return recordShape(msg);
      if (config.mode === "capture") {
        return backend("/capture", {
          source: "nurturecloud",
          capturedAt: new Date().toISOString(),
          endpoint: `${msg.method} ${templatePath(msg.url)}`,
          url: msg.url,
          status: msg.status,
          body: msg.body
        }, config).catch((e) => console.warn("[fua] capture upload failed:", e.message));
      }
      return;
    }

    case "suggest":
      if (config.mode !== "capture") return { ok: false, error: `Suggestions are off in "${config.mode}" mode.` };
      try {
        const suggestion = await backend("/suggest", { contactId: msg.contactId, regenerate: !!msg.regenerate, pageUrl: msg.pageUrl }, config);
        return { ok: true, suggestion };
      } catch (e) {
        return { ok: false, error: e.message };
      }

    case "drafted":
      // Records that a draft was placed in the SMS box -- not that it was sent.
      // The actual send shows up later in NurtureCloud's own history.
      if (config.mode === "capture") await backend("/drafted", { contactId: msg.contactId, at: new Date().toISOString() }, config).catch(() => {});
      return;

    case "checkDraft":
      return checkDraft(msg.text, config);

    case "getEndpoints":
      if (!endpoints) endpoints = (await chrome.storage.local.get("endpoints")).endpoints || {};
      return endpoints;

    case "clearEndpoints":
      endpoints = {};
      await chrome.storage.local.set({ endpoints });
      return;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
