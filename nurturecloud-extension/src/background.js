import { DEFAULTS } from "./config.js";
import { shapeOf, mergeShapes, templatePath } from "./shape.js";
import { checkDraft } from "./sms.js";
import * as store from "./data/store.js";
import { runBackfill, isSet } from "./data/backfill.js";
import { runDelta } from "./data/sync.js";
import { suggest, buildCallList } from "./brain.js";

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

// --- Discovery: in-memory endpoint map, saved at most once a second ----------
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

// --- Backend (thin: only /draft and /vault-events) ---------------------------
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

// --- Authenticated NurtureCloud fetch, executed in the page's tab -------------
// Data lives in the extension origin; only the fetch runs where the agent's
// NurtureCloud session (cookies + bearer token) is available.
function authedFetchVia(tabId, authHeaders) {
  return async (url, opts = {}) => {
    const res = await chrome.tabs.sendMessage(tabId, {
      type: "authedFetch",
      url,
      headers: { ...authHeaders, ...(opts.headers || {}) }
    });
    if (!res?.ok) {
      const err = new Error(res?.error || `fetch failed: ${url}`);
      err.status = res?.status;
      throw err;
    }
    return res.body;
  };
}

// Only the lead list is required. Everything else (pagination, nextPath vs
// totalPath, messages, calls, updatedSinceParam) may stay as a TODO placeholder
// and backfill skips it.
async function requireEndpoints(config) {
  const ep = config.endpoints;
  if (!isSet(ep?.leads?.url)) throw new Error("NurtureCloud endpoints not configured yet (missing leads.url). Fill them from the discovery/HAR session in the extension options.");
  return ep;
}

// --- Message router ----------------------------------------------------------
async function handle(msg, sender) {
  const config = await getConfig();
  switch (msg.type) {
    case "getConfig":
      return config;

    case "capture": {
      if (config.mode === "off" || !shouldCapture(msg.url, config)) return;
      if (JSON.stringify(msg.body).length > config.maxBodyBytes) return;
      if (config.mode === "discovery") return recordShape(msg);
      // In capture/backfill modes the page hook still feeds discovery shapes so
      // the endpoint map stays warm; ingestion into the store happens through
      // the backfill/sync path, which knows how to map each endpoint.
      return recordShape(msg);
    }

    case "runBackfill": {
      try {
        const ep = await requireEndpoints(config);
        const tabId = sender?.tab?.id ?? msg.tabId;
        if (!tabId) throw new Error("No NurtureCloud tab to run the backfill in.");
        const fetchJson = authedFetchVia(tabId, msg.authHeaders || {});
        const result = await runBackfill({
          endpoints: ep,
          authHeaders: msg.authHeaders || {},
          fetchJson,
          store,
          onProgress: (p) => chrome.runtime.sendMessage({ type: "backfillProgress", ...p }).catch(() => {})
        });
        await store.setMeta("lastBackfill", new Date().toISOString());
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case "runSync": {
      try {
        const ep = await requireEndpoints(config);
        const tabId = sender?.tab?.id ?? msg.tabId;
        const since = (await store.getMeta("syncCursor")) || null;
        const newest = await runDelta({ endpoints: ep, authHeaders: msg.authHeaders || {}, fetchJson: authedFetchVia(tabId, msg.authHeaders || {}), since });
        if (newest) await store.setMeta("syncCursor", newest);
        return { ok: true, since, newest };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case "suggest":
      try {
        return await suggest(msg.contactId, { store, config, backend: config.backendUrl ? (path, body) => backend(path, body, config) : null });
      } catch (e) {
        return { ok: false, error: e.message };
      }

    case "callList":
      try {
        return await buildCallList({ store, config });
      } catch (e) {
        return { ok: false, error: e.message };
      }

    case "drafted":
      // Records locally that a draft was placed in the SMS box -- not that it
      // was sent. The real send shows up later in NurtureCloud's own history.
      await store.setMeta(`drafted:${msg.contactId}`, new Date().toISOString());
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});
