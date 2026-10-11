import test from "node:test";
import assert from "node:assert/strict";
import { runBackfill, walkPages, makeRequester, BACKOFF_MS } from "../../src/data/backfill.js";
import { runDelta } from "../../src/data/sync.js";

const endpoints = {
  leads: { url: "https://x/leads", pageParam: "page", perPage: 2, itemsPath: "data", nextPath: "next", updatedSinceParam: "since" },
  messages: { urlTemplate: "https://x/c/:id/msgs", itemsPath: "items" },
  calls: { urlTemplate: "https://x/c/:id/calls", itemsPath: "items" }
};

const pages = {
  1: { data: [{ id: 1, firstName: "A", updatedAt: "2026-01-01T00:00:00Z" }, { id: 2, firstName: "B", updatedAt: "2026-02-01T00:00:00Z" }], next: true },
  2: { data: [{ id: 3, firstName: "C", updatedAt: "2026-03-01T00:00:00Z" }], next: false }
};

// In-memory fake API; `fail429` = number of 429s to emit on the first lead page.
function makeApi({ fail429 = 0 } = {}) {
  const calls = [];
  let remaining429 = fail429;
  const fetchJson = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.pathname === "/leads") {
      if (remaining429-- > 0) throw Object.assign(new Error("429"), { status: 429 });
      return pages[u.searchParams.get("page")];
    }
    const id = u.pathname.split("/")[2];
    if (u.pathname.endsWith("/msgs")) return { items: [{ id: `m${id}`, direction: "out", body: "hi", createdAt: "2026-01-05T00:00:00Z" }] };
    return { items: [{ id: `c${id}`, startedAt: "2026-01-06T00:00:00Z" }] };
  };
  return { fetchJson, calls };
}

function makeStore() {
  const s = { leads: [], messages: [], meta: {}, leadBatches: 0, msgBatches: 0 };
  s.upsertLeads = async (rows) => { s.leadBatches++; s.leads.push(...rows); };
  s.upsertMessages = async (rows) => { s.msgBatches++; s.messages.push(...rows); };
  s.setMeta = async (k, v) => { s.meta[k] = v; };
  return s;
}

test("walkPages follows nextPath across pages", async () => {
  const { fetchJson } = makeApi();
  const request = makeRequester({ fetchJson, throttleMs: 0 });
  const got = [];
  for await (const { items } of walkPages(endpoints.leads, request)) got.push(items.length);
  assert.deepEqual(got, [2, 1]);
});

test("runBackfill fetches 2 pages, history, and writes to the store", async () => {
  const { fetchJson, calls } = makeApi();
  const store = makeStore();
  const progress = [];
  const res = await runBackfill({
    endpoints, authHeaders: { Authorization: "Bearer t" }, fetchJson, throttleMs: 0, store,
    onProgress: (p) => progress.push(p)
  });
  assert.deepEqual(res, { leads: 3, messages: 6, aborted: false });
  assert.equal(store.msgBatches, 3); // one batch per contact
  assert.equal(store.leadBatches, 2 + 3); // 2 pages + 3 enrich writes
  assert.equal(store.messages.length, 6);
  assert.equal(calls.length, 2 + 3 * 2);
  assert.ok(calls.every((c) => c.opts.headers.Authorization === "Bearer t"));
  const enriched = store.leads.filter((l) => l.callCount === 1);
  assert.equal(enriched.length, 3);
  assert.equal(enriched[0].smsCount, 1);
  assert.ok(store.meta.backfill.completedAt);
  assert.deepEqual(progress.at(-1), { phase: "done", done: 3, total: 3 });
  assert.ok(progress.some((p) => p.phase === "leads") && progress.some((p) => p.phase === "history"));
});

test("429 triggers exponential backoff then succeeds", async () => {
  const { fetchJson } = makeApi({ fail429: 3 });
  const sleeps = [];
  const res = await runBackfill({
    endpoints, fetchJson, throttleMs: 0, store: makeStore(), sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.equal(res.leads, 3);
  assert.deepEqual(sleeps.filter((ms) => ms > 0), [2000, 4000, 8000]);
});

test("gives up after 4 retries on persistent 429", async () => {
  const { fetchJson } = makeApi({ fail429: 99 });
  const sleeps = [];
  await assert.rejects(
    runBackfill({ endpoints, fetchJson, throttleMs: 0, store: makeStore(), sleep: async (ms) => { sleeps.push(ms); } }),
    { status: 429 }
  );
  assert.deepEqual(sleeps.filter((ms) => ms > 0), BACKOFF_MS);
});

test("throttle sleeps between requests", async () => {
  const { fetchJson } = makeApi();
  const sleeps = [];
  await runBackfill({ endpoints, fetchJson, throttleMs: 50, store: makeStore(), sleep: async (ms) => { sleeps.push(ms); } });
  assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms > 0 && ms <= 50));
});

test("AbortSignal stops the backfill", async () => {
  const { fetchJson, calls } = makeApi();
  const ac = new AbortController();
  const store = makeStore();
  const res = await runBackfill({
    endpoints, fetchJson, throttleMs: 0, store, signal: ac.signal,
    onProgress: (p) => { if (p.phase === "leads") ac.abort(); }
  });
  assert.equal(res.aborted, true);
  assert.equal(store.msgBatches, 0);
  assert.equal(calls.length, 1);
  assert.equal(store.meta.backfill, undefined);
});

test("runDelta returns newest updatedAt and skips stale records", async () => {
  const { fetchJson, calls } = makeApi();
  const store = makeStore();
  const cursor = await runDelta({ endpoints, fetchJson, since: "2026-01-15T00:00:00.000Z", throttleMs: 0, store });
  assert.equal(cursor, "2026-03-01T00:00:00.000Z");
  assert.equal(store.msgBatches, 2); // lead 1 is older than the cursor
  assert.ok(calls[0].url.includes("since="));
});
