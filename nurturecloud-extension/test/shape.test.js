import test from "node:test";
import assert from "node:assert/strict";
import { shapeOf, mergeShapes, templatePath } from "../src/shape.js";

test("shapeOf keeps structure, not values", () => {
  const shape = shapeOf({ id: "abc", name: "Jas", age: 40, tags: ["a", "b"] });
  assert.deepEqual(shape, { id: "string", name: "string", age: "number", tags: { "[]": "string" } });
});

test("shapeOf summarises arrays by merging item shapes", () => {
  const shape = shapeOf([{ a: 1 }, { a: 2, b: "x" }]);
  assert.deepEqual(shape, { "[]": { a: "number", b: "string" } });
});

test("shapeOf never leaks a scalar value", () => {
  const json = JSON.stringify(shapeOf({ phone: "+61400000000", note: "call back tuesday" }));
  assert.ok(!json.includes("61400"));
  assert.ok(!json.includes("tuesday"));
});

test("mergeShapes unions differing scalar types", () => {
  assert.equal(mergeShapes("number", "null"), "null|number");
});

test("mergeShapes deep-merges object keys", () => {
  assert.deepEqual(mergeShapes({ a: "number" }, { b: "string" }), { a: "number", b: "string" });
});

test("templatePath strips ids, numbers and pii, sorts query keys", () => {
  assert.equal(
    templatePath("https://app.nurturecloud.com/api/contacts/8f3a9c2e1b4d5a6f7890/notes?q=smith&page=2"),
    "app.nurturecloud.com/api/contacts/:id/notes?page&q"
  );
  assert.equal(templatePath("https://app.nurturecloud.com/api/leads/12345"), "app.nurturecloud.com/api/leads/:n");
  assert.equal(templatePath("https://app.nurturecloud.com/u/jas%40ray.com/x"), "app.nurturecloud.com/u/:pii/x");
});
