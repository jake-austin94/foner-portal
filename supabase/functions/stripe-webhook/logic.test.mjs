// node --test supabase/functions/stripe-webhook/logic.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { idOf, money, mapSubscription, planEvent } from "./logic.js";

const ev = (type, object) => ({ id: "evt_1", type, data: { object } });
const sub = (o = {}) => ({
  id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, cancel_at: null,
  items: { data: [{ current_period_end: 1795000000, price: { recurring: { interval: "month" } } }] },
  ...o,
});

test("idOf takes an id or an expanded object", () => {
  assert.equal(idOf("cus_1"), "cus_1");
  assert.equal(idOf({ id: "cus_2", email: "a@b.c" }), "cus_2");
  assert.equal(idOf(null), null);
  assert.equal(idOf(undefined), null);
});

test("money formats pounds with £ and other currencies with a code", () => {
  assert.equal(money(4900, "gbp"), "£49.00");
  assert.equal(money(1000, "GBP"), "£10.00");
  assert.equal(money(500, "eur"), "5.00 EUR");
});

test("mapSubscription reads the period end from the item, not the subscription", () => {
  const m = mapSubscription(sub());
  assert.equal(m.stripe_subscription_id, "sub_1");
  assert.equal(m.status, "active");
  assert.equal(m.billing_interval, "month");
  assert.equal(m.current_period_end, new Date(1795000000 * 1000).toISOString());
  assert.equal(m.cancel_at_period_end, false);
});

test("mapSubscription falls back to a top-level period end on older API versions", () => {
  const s = sub({ current_period_end: 1790000000, items: { data: [{ price: { recurring: { interval: "year" } } }] } });
  const m = mapSubscription(s);
  assert.equal(m.current_period_end, new Date(1790000000 * 1000).toISOString());
  assert.equal(m.billing_interval, "year");
});

test("mapSubscription treats portal cancellation (period end) and dated cancellation as 'ending'", () => {
  assert.equal(mapSubscription(sub({ cancel_at_period_end: true })).cancel_at_period_end, true);
  assert.equal(mapSubscription(sub({ cancel_at: 1800000000 })).cancel_at_period_end, true);
});

test("mapSubscription never produces a status or interval the database would reject", () => {
  assert.equal(mapSubscription(sub({ status: "something_new" })).status, "incomplete");
  const weird = sub({ items: { data: [{ current_period_end: 1795000000, price: { recurring: { interval: "week" } } }] } });
  assert.equal(mapSubscription(weird).billing_interval, null);
  assert.equal(mapSubscription({ id: "sub_x", status: "active" }).current_period_end, null);
});

test("subscription lifecycle events all route to a subscription refresh", () => {
  for (const t of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
    assert.deepEqual(planEvent(ev(t, sub())), { kind: "subscription", customerId: "cus_1", subscriptionId: "sub_1" });
  }
});

test("checkout completion refreshes the subscription, but only for subscription mode", () => {
  const done = { mode: "subscription", customer: "cus_1", subscription: "sub_9" };
  assert.deepEqual(planEvent(ev("checkout.session.completed", done)), { kind: "subscription", customerId: "cus_1", subscriptionId: "sub_9" });
  assert.deepEqual(planEvent(ev("checkout.session.completed", { ...done, mode: "payment" })), { kind: "ignore" });
});

test("expanded customer and subscription objects are handled", () => {
  const done = { mode: "subscription", customer: { id: "cus_7" }, subscription: { id: "sub_7" } };
  assert.deepEqual(planEvent(ev("checkout.session.completed", done)), { kind: "subscription", customerId: "cus_7", subscriptionId: "sub_7" });
});

test("invoice.paid and invoice.payment_failed", () => {
  assert.deepEqual(planEvent(ev("invoice.paid", { id: "in_1", customer: "cus_1" })), { kind: "invoice_paid", customerId: "cus_1", invoiceId: "in_1" });
  const failed = planEvent(ev("invoice.payment_failed", { id: "in_2", customer: "cus_1", amount_due: 4900, currency: "gbp", attempt_count: 2 }));
  assert.equal(failed.kind, "invoice_failed");
  assert.equal(failed.invoiceId, "in_2");
  assert.equal(failed.detail, "Payment of £49.00 failed (attempt 2)");
});

test("disputes and fraud warnings resolve through the charge, not metadata", () => {
  const d = planEvent(ev("charge.dispute.created", { id: "dp_1", charge: "ch_1", amount: 4900, currency: "gbp", reason: "fraudulent" }));
  assert.equal(d.kind, "risk");
  assert.equal(d.alertKind, "dispute");
  assert.equal(d.chargeId, "ch_1");
  assert.equal(d.customerId, null);
  assert.equal(d.detail, "Dispute for £49.00: fraudulent");

  const f = planEvent(ev("radar.early_fraud_warning.created", { id: "issfr_1", charge: { id: "ch_2" }, fraud_type: "card_never_received" }));
  assert.equal(f.alertKind, "fraud_warning");
  assert.equal(f.chargeId, "ch_2");
  assert.equal(f.detail, "Early fraud warning (card_never_received)");
});

test("refunds carry the customer straight off the charge, and a second partial refund is a new alert", () => {
  const a = planEvent(ev("charge.refunded", { id: "ch_3", customer: "cus_1", amount: 4900, amount_refunded: 1000, currency: "gbp" }));
  const b = planEvent(ev("charge.refunded", { id: "ch_3", customer: "cus_1", amount: 4900, amount_refunded: 2000, currency: "gbp" }));
  assert.equal(a.alertKind, "refund");
  assert.equal(a.customerId, "cus_1");
  assert.notEqual(a.objectId, b.objectId);
  assert.equal(a.detail, "Refunded £10.00 of £49.00");
});

test("events we don't act on are ignored", () => {
  assert.deepEqual(planEvent(ev("customer.created", { id: "cus_1" })), { kind: "ignore" });
  assert.deepEqual(planEvent({ type: "invoice.paid" }), { kind: "ignore" });
  assert.deepEqual(planEvent(null), { kind: "ignore" });
});
