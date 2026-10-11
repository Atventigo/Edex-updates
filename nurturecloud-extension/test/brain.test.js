// End to end without a browser: fake NurtureCloud pages -> real backfill ->
// in-memory store -> real scoring -> call list and per-contact suggestion.
import test from "node:test";
import assert from "node:assert/strict";
import { runBackfill } from "../src/data/backfill.js";
import { buildCallList, suggest, vaultEventsFor, VAULT_TTL_MS } from "../src/brain.js";

const NOW = new Date("2026-10-11T10:00:00Z");

function memoryStore() {
  const leads = new Map();
  const messages = new Map();
  const meta = new Map();
  const scores = new Map();
  return {
    scores,
    upsertLeads: async (rows) => rows.forEach((r) => leads.set(r.id, { ...leads.get(r.id), ...r })),
    upsertMessages: async (rows) => rows.forEach((r) => messages.set(r.id, r)),
    getLead: async (id) => leads.get(id) ?? null,
    getMessages: async (id) => [...messages.values()].filter((m) => m.contactId === id).sort((a, b) => (a.at || "").localeCompare(b.at || "")),
    allLeads: async () => [...leads.values()],
    saveScores: async (rows) => rows.forEach((r) => scores.set(r.contactId, r)),
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => meta.set(k, v)
  };
}

// Fake NurtureCloud: 5 contacts over 2 pages of 3, plus SMS history.
const CONTACTS = [
  { id: "alice", firstName: "Alice", lastName: "A", mobile: "+61400000001", stage: "seller", street: "Latrobe Tce", suburb: "Paddington" },
  { id: "ben", firstName: "Ben", lastName: "B", mobile: "+61400000002", stage: "seller", suburb: "Ashgrove" },
  { id: "cara", firstName: "Cara", lastName: "C", mobile: "+61400000003", stage: "seller", suburb: "Bardon" },
  { id: "dan", firstName: "Dan", lastName: "D", mobile: "+61400000004", stage: "seller", suburb: "Milton", doNotContact: true },
  { id: "eve", firstName: "Eve", lastName: "E", mobile: "+61400000005", stage: "buyer", suburb: "Toowong" }
];
const SMS = {
  ben: [
    { id: 1, direction: "outbound", body: "Hi Ben, Jas here. Any plans to sell?", sentAt: "2026-10-01T09:00:00Z" },
    { id: 2, direction: "inbound", body: "Maybe next year, what's it worth?", sentAt: "2026-10-03T12:00:00Z" }
  ],
  cara: [{ id: 3, direction: "outbound", body: "Hi Cara, Jas here.", sentAt: "2026-10-10T09:00:00Z" }]
};

const ENDPOINTS = {
  leads: { url: "https://nc.test/api/contacts", pageParam: "page", perPageParam: "limit", perPage: 3, pageStart: 1, itemsPath: "data", nextPath: "TODO", totalPath: "meta.total" },
  messages: { urlTemplate: "https://nc.test/api/contacts/:id/sms", itemsPath: "items" },
  calls: { urlTemplate: "TODO", itemsPath: "TODO" }
};

function fakeNurtureCloud() {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const sms = u.pathname.match(/^\/api\/contacts\/([^/]+)\/sms$/);
    if (sms) return { items: SMS[decodeURIComponent(sms[1])] || [] };
    const page = Number(u.searchParams.get("page"));
    const limit = Number(u.searchParams.get("limit"));
    return { data: CONTACTS.slice((page - 1) * limit, page * limit), meta: { total: CONTACTS.length } };
  };
  return { fetchJson, calls };
}

async function syncedStore() {
  const store = memoryStore();
  const nc = fakeNurtureCloud();
  const result = await runBackfill({ endpoints: ENDPOINTS, fetchJson: nc.fetchJson, store, throttleMs: 0, sleep: async () => {} });
  return { store, result, nc };
}

test("backfill pulls every lead across pages plus SMS history", async () => {
  const { store, result } = await syncedStore();
  assert.equal((await store.allLeads()).length, 5);
  assert.equal(result.leads, 5);
  assert.equal((await store.getMessages("ben")).length, 2);
});

test("call list puts the unanswered reply first and leaves out skips and nurtures", async () => {
  const { store } = await syncedStore();
  const res = await buildCallList({ store, config: { callListLimit: 10 }, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.total, 5);
  const ids = res.leads.map((l) => l.contactId);
  assert.deepEqual(ids, ["ben", "alice"]);
  assert.ok(!ids.includes("cara"), "contacted yesterday: too soon");
  assert.ok(!ids.includes("dan"), "do not contact");
  assert.ok(!ids.includes("eve"), "buyer never contacted: nurture, not call");
  assert.equal(store.scores.get("dan").bucket, "skip");
  assert.equal(store.scores.get("cara").bucket, "skip");
});

test("call list respects the size limit", async () => {
  const { store } = await syncedStore();
  const res = await buildCallList({ store, config: { callListLimit: 1 }, now: NOW });
  assert.deepEqual(res.leads.map((l) => l.contactId), ["ben"]);
});

test("empty store gives a clear note instead of an error", async () => {
  const res = await buildCallList({ store: memoryStore(), config: { callListLimit: 10 }, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.leads.length, 0);
  assert.match(res.note, /Backfill/);
});

test("suggestion sends the backend only minimal context, never the phone number", async () => {
  const { store } = await syncedStore();
  const sent = [];
  const backend = async (path, body) => {
    sent.push({ path, body });
    if (path === "/draft") return { sms: "Hi Ben, it's Jas from Ray White. Happy to run numbers for you. Reply STOP to opt out", talkingPoint: "Follow up on his question about value." };
    return { events: [] };
  };
  const res = await suggest("ben", { store, backend, config: { agentName: "Jas" }, now: NOW });
  assert.equal(res.ok, true);
  assert.match(res.suggestion.smsDraft, /Reply STOP/);
  assert.match(res.suggestion.reason, /repl/i);
  const draftCall = sent.find((s) => s.path === "/draft");
  assert.ok(draftCall, "draft requested");
  assert.equal(draftCall.body.context.agentName, "Jas");
  const payload = JSON.stringify(sent);
  assert.ok(!payload.includes("+614"), "no phone numbers leave the browser");
  assert.ok(!payload.includes("Latrobe") || sent.some((s) => s.path === "/vault-events"), "street only goes to the VaultRE lookup");
});

test("suggestion still works with no backend configured", async () => {
  const { store } = await syncedStore();
  const res = await suggest("alice", { store, backend: null, config: { agentName: "Jas" }, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.suggestion.smsDraft, "");
  assert.ok(res.suggestion.talkingPoint.length > 0, "falls back to the scoring reason");
});

test("unsynced contact gets a clear message", async () => {
  const res = await suggest("nobody", { store: memoryStore(), backend: null, config: {}, now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.error, /synced/);
});

test("a sale on the lead's street lifts them and is cached per suburb", async () => {
  const { store } = await syncedStore();
  let vaultHits = 0;
  const backend = async (path) => {
    if (path === "/vault-events") {
      vaultHits++;
      return { events: [{ type: "sold", address: "8 Latrobe Tce, Paddington", date: "2026-10-08" }] };
    }
    return { sms: "Hi Alice. Reply STOP to opt out", talkingPoint: "Mention the sale at 8 Latrobe Tce." };
  };
  const before = (await buildCallList({ store, config: { callListLimit: 10 }, now: NOW })).leads.find((l) => l.contactId === "alice").priority;
  const res = await suggest("alice", { store, backend, config: { agentName: "Jas" }, now: NOW });
  assert.match(res.suggestion.reason, /Latrobe/);
  assert.ok(res.suggestion.priority > before, "street sale boosts priority");
  await vaultEventsFor({ suburb: "Paddington" }, { store, backend, nowMs: NOW.getTime() + 1000 });
  assert.equal(vaultHits, 1, "second lookup within the TTL is served from cache");
  await vaultEventsFor({ suburb: "Paddington" }, { store, backend, nowMs: NOW.getTime() + VAULT_TTL_MS + 1 });
  assert.equal(vaultHits, 2, "refetched after the TTL");
});

test("VaultRE failure falls back to cached events instead of breaking", async () => {
  const store = memoryStore();
  await store.setMeta("vault:paddington", { at: 0, events: [{ type: "listed", address: "1 X St", date: "2026-10-01" }] });
  const backend = async () => { throw new Error("down"); };
  const events = await vaultEventsFor({ suburb: "Paddington" }, { store, backend, nowMs: VAULT_TTL_MS * 10 });
  assert.equal(events.length, 1);
});
