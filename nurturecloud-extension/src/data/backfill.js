// Active backfill: walk the lead list, then fetch each contact's messages and calls.
// Everything NurtureCloud-specific comes from the injected `endpoints` config.
//
// Deviations / additions vs ARCHITECTURE.md (signature is a superset):
//  - extra optional args `store` (default: ./store.js) and `sleep` (default: real
//    timer) so tests can inject fakes.
//  - fetchJson(url, {headers}) must reject with an error carrying `.status`
//    (e.g. 429) for HTTP failures; 429 is retried with 2s/4s/8s/16s backoff.
//  - Raw-record field names are guesses (see mapLead/mapMessage); adjust after
//    the endpoint-mapping session.
import * as realStore from "./store.js";

export const BACKOFF_MS = [2000, 4000, 8000, 16000];

// "a.b.0.c" -> value, or undefined. Empty/TODO path returns the object itself.
export function getPath(obj, path) {
  if (!isSet(path)) return obj;
  let cur = obj;
  for (const key of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const isAbort = (e) => e?.name === "AbortError";

// A config value counts as set unless empty or still a TODO placeholder.
export const isSet = (v) => v != null && v !== "" && !String(v).startsWith("TODO");

function withParams(url, params) {
  const qs = Object.entries(params)
    .filter(([k, v]) => isSet(k) && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

// Rate-limited, 429-retrying, abortable request function.
export function makeRequester({ fetchJson, authHeaders = {}, throttleMs = 1000, signal, sleep: sleepFn = sleep }) {
  let last = -Infinity;
  return async function request(url) {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError();
      const wait = last + throttleMs - Date.now();
      if (wait > 0) await sleepFn(wait, signal);
      last = Date.now();
      try {
        return await fetchJson(url, { headers: { ...authHeaders } });
      } catch (err) {
        if (isAbort(err)) throw err;
        if (err?.status !== 429 || attempt >= BACKOFF_MS.length) throw err;
        await sleepFn(BACKOFF_MS[attempt], signal);
      }
    }
  };
}

// Async generator over lead pages. Yields { items, total }.
export async function* walkPages(cfg, request, extraParams = {}) {
  let page = cfg.pageStart ?? 1;
  let seen = 0;
  for (;;) {
    const params = { ...extraParams };
    if (isSet(cfg.pageParam)) params[cfg.pageParam] = page;
    if (isSet(cfg.perPageParam) && cfg.perPage) params[cfg.perPageParam] = cfg.perPage;
    const body = await request(withParams(cfg.url, params));
    const items = getPath(body, cfg.itemsPath) ?? [];
    seen += items.length;
    const total = isSet(cfg.totalPath) ? getPath(body, cfg.totalPath) : undefined;
    yield { items, total };
    if (!items.length) return;
    if (isSet(cfg.nextPath)) {
      if (!getPath(body, cfg.nextPath)) return;
    } else if (total != null) {
      if (seen >= total) return;
    } else if (cfg.perPage && items.length < cfg.perPage) return;
    page++;
  }
}

const pick = (raw, ...keys) => {
  for (const k of keys) {
    const v = getPath(raw, k);
    if (v != null && v !== "") return v;
  }
  return undefined;
};

const iso = (v) => {
  if (v == null || v === "") return null;
  const d = new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Raw NurtureCloud contact -> data-model lead.
export function mapLead(raw) {
  const name = pick(raw, "name", "fullName") ?? [raw.firstName, raw.lastName].filter(Boolean).join(" ");
  const street = pick(raw, "street", "address.street") ?? null;
  const suburb = pick(raw, "suburb", "address.suburb") ?? null;
  return {
    id: String(pick(raw, "id", "contactId", "_id")),
    name: name || "",
    firstName: pick(raw, "firstName", "first_name") ?? String(name || "").split(" ")[0],
    phone: pick(raw, "phone", "mobile", "phoneNumber") ?? null,
    stage: pick(raw, "stage", "status") ?? null,
    owner: pick(raw, "owner", "ownerName", "assignedTo") ?? null,
    suburb,
    street,
    address: pick(raw, "address.full", "fullAddress") ?? (typeof raw.address === "string" ? raw.address : [street, suburb].filter(Boolean).join(", ") || null),
    lastContactedAt: iso(pick(raw, "lastContactedAt", "lastContacted")),
    lastContactChannel: pick(raw, "lastContactChannel") ?? null,
    lastInboundAt: iso(pick(raw, "lastInboundAt")),
    smsCount: Number(pick(raw, "smsCount") ?? 0),
    callCount: Number(pick(raw, "callCount") ?? 0),
    responded: Boolean(pick(raw, "responded") ?? false),
    doNotContact: Boolean(pick(raw, "doNotContact", "dnc", "unsubscribed") ?? false),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean) : [],
    updatedAt: iso(pick(raw, "updatedAt", "updated_at", "modifiedAt"))
  };
}

const IN_WORDS = /^(in|inbound|incoming|received|reply)$/i;

// Raw message/call record -> data-model message. Ids are prefixed by channel to avoid collisions.
export function mapMessage(raw, contactId, channel = "sms") {
  const body = String(pick(raw, "body", "text", "message", "notes", "summary") ?? "");
  const dir = pick(raw, "direction", "type");
  const ch = channel === "sms" ? String(pick(raw, "channel") ?? "sms").toLowerCase() : channel;
  return {
    id: `${ch}:${pick(raw, "id", "_id")}`,
    contactId: String(contactId),
    direction: dir != null && IN_WORDS.test(String(dir)) ? "in" : "out",
    channel: ch === "call" || ch === "email" ? ch : "sms",
    at: iso(pick(raw, "at", "createdAt", "sentAt", "timestamp", "date", "startedAt")),
    segments: Number(pick(raw, "segments")) || (ch === "sms" && body ? Math.ceil(body.length / 160) : 0),
    bodyPreview: body.slice(0, 140)
  };
}

// Fold a contact's history into its lead (counts + last-contact fields).
export function enrichLead(lead, messages) {
  const out = messages.filter((m) => m.direction === "out" && m.at).sort((a, b) => b.at.localeCompare(a.at));
  const inb = messages.filter((m) => m.direction === "in" && m.at).sort((a, b) => b.at.localeCompare(a.at));
  return {
    ...lead,
    smsCount: messages.filter((m) => m.channel === "sms").length,
    callCount: messages.filter((m) => m.channel === "call").length,
    lastContactedAt: out[0]?.at ?? lead.lastContactedAt,
    lastContactChannel: out[0]?.channel ?? lead.lastContactChannel,
    lastInboundAt: inb[0]?.at ?? lead.lastInboundAt,
    responded: lead.responded || inb.length > 0
  };
}

// Fetch + map one contact's messages and calls (either endpoint may be unset).
export async function fetchHistory(endpoints, contactId, request) {
  const rows = [];
  for (const [key, channel] of [["messages", "sms"], ["calls", "call"]]) {
    const cfg = endpoints[key];
    if (!cfg || !isSet(cfg.urlTemplate)) continue;
    const body = await request(cfg.urlTemplate.replace(":id", encodeURIComponent(contactId)));
    for (const raw of getPath(body, cfg.itemsPath) ?? []) rows.push(mapMessage(raw, contactId, channel));
  }
  return rows;
}

export async function runBackfill({
  endpoints,
  authHeaders = {},
  fetchJson,
  onProgress = () => {},
  throttleMs = 1000,
  signal,
  store = realStore,
  sleep: sleepFn = sleep
}) {
  const request = makeRequester({ fetchJson, authHeaders, throttleMs, signal, sleep: sleepFn });
  const result = { leads: 0, messages: 0, aborted: false };
  try {
    const ids = [];
    for await (const { items, total } of walkPages(endpoints.leads, request)) {
      const leads = items.map(mapLead);
      await store.upsertLeads(leads);
      ids.push(...leads);
      result.leads += leads.length;
      onProgress({ phase: "leads", done: ids.length, total: total ?? null });
    }
    let done = 0;
    for (const lead of ids) {
      const msgs = await fetchHistory(endpoints, lead.id, request);
      await store.upsertMessages(msgs);
      await store.upsertLeads([enrichLead(lead, msgs)]);
      result.messages += msgs.length;
      onProgress({ phase: "history", done: ++done, total: ids.length });
    }
    await store.setMeta("backfill", { completedAt: new Date().toISOString(), ...result });
    onProgress({ phase: "done", done: ids.length, total: ids.length });
  } catch (err) {
    if (!isAbort(err)) throw err;
    result.aborted = true;
  }
  return result;
}
