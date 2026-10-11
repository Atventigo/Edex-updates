import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreLead, rankLeads, dailyCallList, normalizeStreet,
  W_AWAITING_REPLY, W_VAULT_EVENT,
} from "../../src/scoring/score.js";

const NOW = new Date("2026-06-15T00:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const lead = (o = {}) => ({
  id: "c1", stage: "buyer", street: "Smith Street", address: "10 Smith Street",
  lastContactedAt: null, lastInboundAt: null, smsCount: 0, callCount: 0,
  responded: false, doNotContact: false, ...o,
});

test("doNotContact is skip, priority 0, with a reason", () => {
  const r = scoreLead(lead({ doNotContact: true, stage: "seller" }), [], [], NOW);
  assert.equal(r.bucket, "skip");
  assert.equal(r.priority, 0);
  assert.equal(r.nextActionAt, null);
  assert.equal(r.reasons.length, 1);
});

test("contacted <2 days ago is skip with nextActionAt = last + 2 days", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(1) }), [], [], NOW);
  assert.equal(r.bucket, "skip");
  assert.ok(r.reasons.includes("Contacted recently (too soon)"));
  assert.equal(r.nextActionAt, new Date(NOW.getTime() - 86400000 + 2 * 86400000).toISOString());
});

test("exactly 2 days ago is no longer too soon", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(2) }), [], [], NOW);
  assert.notEqual(r.bucket, "skip");
});

test("inbound after our last contact is call_today with large boost", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(5), lastInboundAt: daysAgo(1), responded: true }), [], [], NOW);
  assert.equal(r.bucket, "call_today");
  assert.ok(r.priority >= W_AWAITING_REPLY);
  assert.equal(r.suggestedChannel, "call");
  assert.ok(r.reasons.some((x) => /replied/i.test(x)));
});

test("awaiting reply overrides the too-soon gate", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(1), lastInboundAt: daysAgo(0.5) }), [], [], NOW);
  assert.equal(r.bucket, "call_today");
});

test("inbound found only in messages still counts", () => {
  const msgs = [{ direction: "out", at: daysAgo(6) }, { direction: "in", at: daysAgo(3) }];
  const r = scoreLead(lead({ lastContactedAt: daysAgo(6) }), msgs, [], NOW);
  assert.equal(r.bucket, "call_today");
});

test("answered inbound (our contact after it) is not awaiting", () => {
  const r = scoreLead(lead({ lastInboundAt: daysAgo(10), lastContactedAt: daysAgo(5), responded: true }), [], [], NOW);
  assert.notEqual(r.bucket, "call_today");
});

test("never contacted seller: high, call_today", () => {
  const r = scoreLead(lead({ stage: "Seller" }), [], [], NOW);
  assert.equal(r.bucket, "call_today");
  assert.ok(r.priority >= 50);
  assert.equal(r.nextActionAt, NOW.toISOString());
});

test("never contacted buyer: medium, nurture, sms", () => {
  const r = scoreLead(lead({ stage: "buyer" }), [], [], NOW);
  assert.equal(r.bucket, "nurture");
  assert.ok(r.priority > 10 && r.priority < 50);
  assert.equal(r.suggestedChannel, "sms");
});

const base = lead({ lastContactedAt: daysAgo(5), responded: true, lastInboundAt: daysAgo(6) });

test("vault event within 14 days boosts and is named in reasons", () => {
  const ev = [{ type: "sold", address: "22 Smith St, Newtown", date: daysAgo(3), price: 900000 }];
  const without = scoreLead(base, [], [], NOW);
  const withEv = scoreLead(base, [], ev, NOW);
  assert.equal(withEv.priority - without.priority, W_VAULT_EVENT);
  assert.ok(withEv.reasons.some((x) => /Sold/.test(x) && /22 Smith St/.test(x)));
  assert.equal(withEv.suggestedChannel, "call");
});

test("vault event older than 14 days does NOT boost", () => {
  const ev = [{ type: "listed", address: "22 Smith St", date: daysAgo(15) }];
  const a = scoreLead(base, [], [], NOW);
  const b = scoreLead(base, [], ev, NOW);
  assert.equal(b.priority, a.priority);
  assert.deepEqual(b.reasons, a.reasons);
});

test("vault event on a different street does not boost", () => {
  const ev = [{ type: "listed", address: "22 Jones St", date: daysAgo(2) }];
  assert.equal(scoreLead(base, [], ev, NOW).priority, scoreLead(base, [], [], NOW).priority);
});

test("normalizeStreet handles numbers, units and suffix abbreviations", () => {
  assert.equal(normalizeStreet("12/34 Smith St, Newtown"), "smith street");
  assert.equal(normalizeStreet("Smith Street"), "smith street");
});

test("warm lead silent 30-90 days is nurture leaning call", () => {
  const l = lead({ stage: "seller", lastContactedAt: daysAgo(45), responded: true });
  const r = scoreLead(l, [], [], NOW);
  assert.equal(r.bucket, "nurture");
  assert.equal(r.suggestedChannel, "call");
  assert.ok(r.reasons.some((x) => /silent for 45 days/.test(x)));
});

test("warm buyer silent 45 days is nurture via sms", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(45), responded: true }), [], [], NOW);
  assert.equal(r.bucket, "nurture");
  assert.equal(r.suggestedChannel, "sms");
});

test("silent >90 days never responded: low nurture", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(120), smsCount: 1 }), [], [], NOW);
  assert.equal(r.bucket, "nurture");
  assert.ok(r.priority <= 10);
});

test("silent >90 days never responded after many attempts: skip", () => {
  const r = scoreLead(lead({ lastContactedAt: daysAgo(120), smsCount: 4 }), [], [], NOW);
  assert.equal(r.bucket, "skip");
});

test("priority is clamped to 0..100", () => {
  const ev = [{ type: "sold", address: "1 Smith St", date: daysAgo(1) }];
  const r = scoreLead(lead({ lastContactedAt: daysAgo(5), lastInboundAt: daysAgo(1), stage: "seller" }), [], ev, NOW);
  assert.ok(r.priority <= 100 && r.priority >= 0);
});

const s = (contactId, priority, nextActionAt = null, bucket = "call_today") =>
  ({ contactId, priority, bucket, reasons: [], suggestedChannel: "call", nextActionAt });

test("rankLeads sorts by priority desc without mutating input", () => {
  const input = [s("a", 10), s("b", 90), s("c", 50)];
  const out = rankLeads(input);
  assert.deepEqual(out.map((x) => x.contactId), ["b", "c", "a"]);
  assert.deepEqual(input.map((x) => x.contactId), ["a", "b", "c"]);
});

test("rankLeads tie-breaks by nextActionAt (null last) then contactId", () => {
  const out = rankLeads([
    s("z", 50, null), s("b", 50, "2026-06-16T00:00:00.000Z"),
    s("a", 50, "2026-06-16T00:00:00.000Z"), s("m", 50, "2026-06-15T00:00:00.000Z"),
  ]);
  assert.deepEqual(out.map((x) => x.contactId), ["m", "a", "b", "z"]);
});

test("dailyCallList returns only call_today, ranked, capped at limit", () => {
  const list = [s("a", 40), s("b", 90, null, "nurture"), s("c", 80), s("d", 70), s("e", 99, null, "skip")];
  const out = dailyCallList(list, 2);
  assert.deepEqual(out.map((x) => x.contactId), ["c", "d"]);
  assert.ok(out.every((x) => x.bucket === "call_today"));
  assert.equal(dailyCallList(list, 10).length, 3);
  assert.equal(dailyCallList(list, 0).length, 0);
});
