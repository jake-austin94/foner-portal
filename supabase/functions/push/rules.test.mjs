// node --test supabase/functions/push/rules.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { ukParts, priceDue, chaseDue, callMessage, priceMessage, chaseMessage } from "./rules.js";

const at = (s) => new Date(s);
const job = (o = {}) => ({ id: "j", stage: "new", quote_amount: null, created_at: "2026-11-02T10:00:00Z", ...o });
const ids = (r) => r.map((x) => x.id);

test("UK time follows GMT and BST", () => {
  assert.deepEqual(ukParts(at("2026-11-02T18:00:00Z")), { date: "2026-11-02", hour: 18 });
  assert.deepEqual(ukParts(at("2026-07-01T17:00:00Z")), { date: "2026-07-01", hour: 18 });
  assert.deepEqual(ukParts(at("2026-07-01T23:30:00Z")), { date: "2026-07-02", hour: 0 });
});
test("new job nudged the same evening", () => {
  assert.deepEqual(ids(priceDue([job()], [], [], at("2026-11-02T18:00:00Z"))), ["j"]);
});
test("call after 6pm waits for tomorrow's run", () => {
  const j = job({ created_at: "2026-11-02T19:00:00Z" });
  assert.deepEqual(priceDue([j], [], [], at("2026-11-02T18:00:00Z")), []);
  assert.deepEqual(ids(priceDue([j], [], [], at("2026-11-03T18:00:00Z"))), ["j"]);
});
test("repeat comes two days on, then stops", () => {
  const first = { ref_id: "j", sent_at: "2026-11-02T18:00:03Z" };
  const second = { ref_id: "j", sent_at: "2026-11-04T18:00:02Z" };
  assert.deepEqual(priceDue([job()], [], [first], at("2026-11-03T18:00:00Z")), []);
  assert.deepEqual(ids(priceDue([job()], [], [first], at("2026-11-04T18:00:00Z"))), ["j"]);
  assert.deepEqual(priceDue([job()], [], [first, second], at("2026-11-06T18:00:00Z")), []);
});
test("priced, won and lost jobs are left alone", () => {
  const now = at("2026-11-02T18:00:00Z");
  assert.deepEqual(priceDue([job({ quote_amount: 650, stage: "quoted" }), job({ stage: "won" }), job({ stage: "lost" }), job({ quote_amount: 650 })], [], [], now), []);
});
test("booked visit waits until it has happened, then gets its own nudges", () => {
  const j = job({ stage: "visit_booked" });
  const v = { job_id: "j", starts_at: "2026-11-06T15:00:00Z", done: false };
  const early = { ref_id: "j", sent_at: "2026-11-02T18:00:03Z" };
  assert.deepEqual(priceDue([j], [v], [early], at("2026-11-04T18:00:00Z")), []);
  assert.deepEqual(ids(priceDue([j], [v], [early], at("2026-11-06T18:00:00Z"))), ["j"]);
});
test("visit later than 6pm waits for the next evening", () => {
  const j = job({ stage: "visit_booked" });
  const v = { job_id: "j", starts_at: "2026-11-06T18:30:00Z", done: false };
  assert.deepEqual(priceDue([j], [v], [], at("2026-11-06T18:00:00Z")), []);
  assert.deepEqual(ids(priceDue([j], [v], [], at("2026-11-07T18:00:00Z"))), ["j"]);
});
test("old jobs don't start nudging", () => {
  assert.deepEqual(priceDue([job({ created_at: "2026-10-01T10:00:00Z" })], [], [], at("2026-11-02T18:00:00Z")), []);
});
test("chase fires on chase day only, and not once won", () => {
  const e = { id: "e", kind: "callback", done: false, starts_at: "2026-11-05T12:00:00Z", job: { stage: "quoted" } };
  assert.equal(chaseDue([e], "2026-11-05").length, 1);
  assert.equal(chaseDue([e], "2026-11-04").length, 0);
  assert.equal(chaseDue([e], "2026-11-06").length, 0);
  assert.equal(chaseDue([{ ...e, done: true }], "2026-11-05").length, 0);
  assert.equal(chaseDue([{ ...e, job: { stage: "won" } }], "2026-11-05").length, 0);
});
test("wording", () => {
  assert.equal(priceMessage({ id: "1", customer: { name: "John Smith" } }).title, "John Smith still needs a price");
  assert.equal(priceMessage({ id: "1", customer: { name: "John" } }).url, "#/jobs/1/price");
  assert.equal(chaseMessage({ id: "e", job_id: "1", customer: { name: "John Smith" }, job: { stage: "quoted", quote_amount: 650 }, title: "Chase quote (£650)" }).title, "Chase John Smith's £650 quote");
  assert.equal(chaseMessage({ id: "e", job_id: "1", customer: { name: "Sam Jones" }, job: { stage: "quoted", quote_amount: 1250.5 } }).title, "Chase Sam Jones' £1,250.50 quote");
  assert.equal(chaseMessage({ id: "e", customer: { name: "Sam" }, job: null, title: "Ring about gutters" }).title, "Call back Sam");
  assert.equal(callMessage({ id: "c", kind: "no_details" }).title, "New call");
  assert.equal(callMessage({ id: "c", kind: "enquiry", caller_name: "Jo", summary: "Wants a roof clean." }).body, "Wants a roof clean.");
});
