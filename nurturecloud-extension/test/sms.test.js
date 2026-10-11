import test from "node:test";
import assert from "node:assert/strict";
import { checkDraft, smsSegments } from "../src/sms.js";

const opts = { requiredSmsPhrases: ["Jas"], optOutPattern: "\\b(STOP|opt out|unsubscribe)\\b" };

test("clean compliant draft has no warnings", () => {
  const text = "Hi Sam, Jas here from Ray White. A home on your street just sold. Reply STOP to opt out.";
  assert.deepEqual(checkDraft(text, opts), []);
});

test("flags empty draft", () => {
  assert.deepEqual(checkDraft("   ", opts), ["Draft is empty."]);
});

test("flags missing sender name and missing opt-out", () => {
  const warnings = checkDraft("Hi there, just checking in.", opts);
  assert.ok(warnings.some((w) => w.includes("sender")));
  assert.ok(warnings.some((w) => w.includes("opt-out")));
});

test("flags unfilled placeholder", () => {
  const warnings = checkDraft("Hi {{firstName}}, Jas here. Reply STOP to opt out.", opts);
  assert.ok(warnings.some((w) => w.includes("placeholder")));
});

test("flags overly long message", () => {
  const warnings = checkDraft("Jas. Reply STOP to opt out. " + "x".repeat(400), opts);
  assert.ok(warnings.some((w) => w.includes("segments")));
});

test("smsSegments counts GSM-7 and UCS-2 boundaries", () => {
  assert.equal(smsSegments("short"), 1);
  assert.equal(smsSegments("x".repeat(160)), 1);
  assert.equal(smsSegments("x".repeat(161)), 2);
  assert.equal(smsSegments("😀"), 1); // emoji -> UCS-2, single still fits in 70
  assert.equal(smsSegments("😀".repeat(71)), 3); // 71 UCS-2 code points, 67 per part
});
