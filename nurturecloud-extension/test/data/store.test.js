import test from "node:test";
import assert from "node:assert/strict";
import { getPath, sleep, mapLead, mapMessage, enrichLead } from "../../src/data/backfill.js";
import * as store from "../../src/data/store.js";

const hasIDB = globalThis.indexedDB !== undefined;

test("getPath walks nested paths and tolerates missing keys", () => {
  const o = { a: { b: [{ c: 5 }] } };
  assert.equal(getPath(o, "a.b.0.c"), 5);
  assert.equal(getPath(o, "a.x.y"), undefined);
  assert.equal(getPath(o, ""), o);
  assert.equal(getPath(o, "TODO: fill from discovery/HAR"), o);
});

test("sleep resolves and rejects on abort", async () => {
  await sleep(1);
  const ac = new AbortController();
  const p = sleep(10_000, ac.signal);
  ac.abort();
  await assert.rejects(p, { name: "AbortError" });
});

test("mapLead maps raw records to the data model", () => {
  const lead = mapLead({
    id: 7, firstName: "Sam", lastName: "Lee", mobile: "0400", status: "Seller",
    address: { street: "1 Main St", suburb: "Bondi" }, tags: [{ name: "hot" }, "vip"],
    updated_at: "2026-01-02T03:04:05Z", dnc: true
  });
  assert.equal(lead.id, "7");
  assert.equal(lead.name, "Sam Lee");
  assert.equal(lead.suburb, "Bondi");
  assert.equal(lead.address, "1 Main St, Bondi");
  assert.deepEqual(lead.tags, ["hot", "vip"]);
  assert.equal(lead.doNotContact, true);
  assert.equal(lead.updatedAt, "2026-01-02T03:04:05.000Z");
});

test("mapMessage maps direction, channel, segments and preview", () => {
  const m = mapMessage({ id: 1, direction: "inbound", body: "x".repeat(200), createdAt: "2026-01-01T00:00:00Z" }, 9, "sms");
  assert.equal(m.id, "sms:1");
  assert.equal(m.contactId, "9");
  assert.equal(m.direction, "in");
  assert.equal(m.segments, 2);
  assert.equal(m.bodyPreview.length, 140);
  assert.equal(mapMessage({ id: 2, startedAt: "2026-01-01T00:00:00Z" }, 9, "call").channel, "call");
});

test("enrichLead folds history into counts and last-contact fields", () => {
  const lead = mapLead({ id: 1 });
  const out = enrichLead(lead, [
    { channel: "sms", direction: "out", at: "2026-01-01T00:00:00.000Z" },
    { channel: "call", direction: "out", at: "2026-01-03T00:00:00.000Z" },
    { channel: "sms", direction: "in", at: "2026-01-02T00:00:00.000Z" }
  ]);
  assert.equal(out.smsCount, 2);
  assert.equal(out.callCount, 1);
  assert.equal(out.lastContactedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(out.lastContactChannel, "call");
  assert.equal(out.lastInboundAt, "2026-01-02T00:00:00.000Z");
  assert.equal(out.responded, true);
});

test("store degrades gracefully without IndexedDB", { skip: hasIDB }, async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await store.openDB(), null);
    await store.upsertLeads([{ id: "1" }]);
    await store.upsertMessages([{ id: "m", contactId: "1" }]);
    await store.saveScores([{ contactId: "1" }]);
    await store.setMeta("k", 1);
    assert.equal(await store.getLead("1"), null);
    assert.deepEqual(await store.getMessages("1"), []);
    assert.deepEqual(await store.allLeads(), []);
    assert.equal(await store.getMeta("k"), null);
  } finally {
    console.warn = warn;
  }
});

test("store round-trips with real IndexedDB", { skip: !hasIDB && "indexedDB not available" }, async () => {
  await store.upsertLeads([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  await store.upsertMessages([{ id: "m1", contactId: "a" }, { id: "m2", contactId: "b" }]);
  await store.setMeta("cursor", "x");
  assert.equal((await store.getLead("a")).name, "A");
  assert.equal((await store.allLeads()).length, 2);
  assert.deepEqual((await store.getMessages("a")).map((m) => m.id), ["m1"]);
  assert.equal(await store.getMeta("cursor"), "x");
});
