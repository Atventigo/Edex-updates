import { DEFAULTS } from "./config.js";
import { shapeOf, mergeShapes, templatePath } from "./shape.js";
import { checkDraft } from "./sms.js";
import * as store from "./data/store.js";
import { runBackfill } from "./data/backfill.js";
import { runDelta } from "./data/sync.js";
import { scoreLead, rankLeads, dailyCallList } from "./scoring/score.js";

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

// VaultRE events are cached per suburb so bulk ranking doesn't hammer the backend.
const VAULT_TTL_MS = 6 * 60 * 60 * 1000;
async function vaultEventsFor(lead, config) {
  if (!lead?.suburb) return [];
  const key = `vault:${lead.suburb.toLowerCase()}`;
  const cached = await store.getMeta(key);
  if (cached && Date.now() - cached.at < VAULT_TTL_MS) return cached.events;
  try {
    const { events } = await backend("/vault-events", { suburb: lead.suburb, street: lead.street, contactAddress: lead.address }, config);
    await store.setMeta(key, { at: Date.now(), events: events || [] });
    return events || [];
  } catch (e) {
    console.warn("[fua] vault-events failed:", e.message);
    return cached?.events || [];
  }
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

async function requireEndpoints(config) {
  const ep = config.endpoints;
  const hasTodo = JSON.stringify(ep || {}).includes("TODO");
  if (!ep || hasTodo) throw new Error("NurtureCloud endpoints not configured yet. Fill them from the discovery/HAR session (extension options).");
  return ep;
}

// --- Suggestion for one open contact -----------------------------------------
function lastContactSummary(lead, messages) {
  if (!lead?.lastContactedAt) return "No prior contact on record.";
  const when = new Date(lead.lastContactedAt).toLocaleDateString();
  const replied = lead.lastInboundAt && lead.lastInboundAt > lead.lastContactedAt;
  const recent = (messages || []).slice(-1)[0];
  const tail = recent?.bodyPreview ? ` Last message: "${recent.bodyPreview}".` : "";
  return `Last contacted ${when} by ${lead.lastContactChannel || "unknown"}.${replied ? " They have since replied and are awaiting a response." : ""}${tail}`;
}

async function suggest(contactId, config) {
  const lead = await store.getLead(contactId);
  if (!lead) return { ok: false, error: "This contact hasn't been synced yet. Run a backfill or open them after a sync." };
  const messages = await store.getMessages(contactId);
  const events = await vaultEventsFor(lead, config);
  const score = scoreLead(lead, messages, events, new Date());
  await store.saveScores([score]);

  let sms = "";
  let talkingPoint = "";
  try {
    const draft = await backend("/draft", {
      lead: { firstName: lead.firstName, suburb: lead.suburb, stage: lead.stage, lastContactSummary: lastContactSummary(lead, messages) },
      reason: score.reasons.join(" "),
      context: { agentName: config.agentName, suggestedChannel: score.suggestedChannel }
    }, config);
    sms = draft.sms || "";
    talkingPoint = draft.talkingPoint || "";
  } catch (e) {
    talkingPoint = `(Draft unavailable: ${e.message})`;
  }

  return {
    ok: true,
    suggestion: {
      contactName: lead.name || lead.firstName || contactId,
      lastContacted: lead.lastContactedAt ? lastContactSummary(lead, messages) : "No contact on record",
      nextAction: `${score.bucket.replace("_", " ")} · ${score.suggestedChannel}`,
      talkingPoint: talkingPoint || score.reasons[0] || "",
      smsDraft: sms,
      reason: score.reasons.join(" · "),
      priority: score.priority
    }
  };
}

// --- Daily call list: score everyone, rank, take the top --------------------
async function buildCallList(config) {
  const leads = await store.allLeads();
  if (!leads.length) return { ok: true, leads: [], note: "No leads synced yet." };
  const now = new Date();
  const scored = [];
  for (const lead of leads) {
    const messages = await store.getMessages(lead.id);
    const cached = await store.getMeta(`vault:${(lead.suburb || "").toLowerCase()}`);
    scored.push({ ...scoreLead(lead, messages, cached?.events || [], now), name: lead.name || lead.firstName || lead.id });
  }
  await store.saveScores(scored);
  const top = dailyCallList(rankLeads(scored), config.callListLimit);
  return { ok: true, leads: top, total: leads.length };
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
        return await suggest(msg.contactId, config);
      } catch (e) {
        return { ok: false, error: e.message };
      }

    case "callList":
      try {
        return await buildCallList(config);
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
