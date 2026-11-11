// What each Stripe event means for foner. No database or network here, so it can be tested on its own.
// index.ts does the reading and writing; this decides what to do.

// Stripe lets most references arrive as either an id or an expanded object.
export const idOf = (x) => (x && typeof x === "object" ? x.id : x) ?? null;

export const SUB_STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];

/**
 * What index.ts should do about one Stripe event.
 * @typedef {{ kind: "ignore" }
 *   | { kind: "subscription", customerId: string | null, subscriptionId: string | null }
 *   | { kind: "invoice_paid", customerId: string | null, invoiceId: string }
 *   | { kind: "invoice_failed", customerId: string | null, invoiceId: string, detail: string }
 *   | { kind: "risk", alertKind: "dispute" | "refund" | "fraud_warning", objectId: string, chargeId: string | null, customerId: string | null, detail: string }
 * } PlanEvent
 */

/** @type {PlanEvent} */
const IGNORE = { kind: "ignore" };

export function money(amount, currency) {
  const n = (Number(amount) || 0) / 100;
  return String(currency || "").toLowerCase() === "gbp" ? `£${n.toFixed(2)}` : `${n.toFixed(2)} ${String(currency || "").toUpperCase()}`.trim();
}

// A Stripe Subscription -> the columns we mirror in `billing`.
// Since API version 2025-03-31 the period dates live on the subscription ITEM, not the subscription.
/** @param {any} sub */
export function mapSubscription(sub) {
  const item = sub?.items?.data?.[0];
  const end = item?.current_period_end ?? sub?.current_period_end ?? null;
  const interval = item?.price?.recurring?.interval ?? item?.plan?.interval ?? null;
  return {
    stripe_subscription_id: sub.id,
    status: SUB_STATUSES.includes(sub.status) ? sub.status : "incomplete",
    billing_interval: interval === "month" || interval === "year" ? interval : null,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    // The portal's "cancel" sets cancel_at_period_end; a date-based cancel sets cancel_at.
    cancel_at_period_end: !!sub.cancel_at_period_end || sub.cancel_at != null,
  };
}

// Decide what an event needs. Only events we act on are handled; the webhook endpoint
// should be subscribed to exactly these types (see BILLING.md).
/** @param {any} event  @returns {PlanEvent} */
export function planEvent(event) {
  const o = event?.data?.object;
  if (!o) return IGNORE;
  switch (event.type) {
    case "checkout.session.completed":
      // Only the subscription sign-up matters. One-off payments aren't taken through Checkout.
      if (o.mode !== "subscription") return IGNORE;
      return { kind: "subscription", customerId: idOf(o.customer), subscriptionId: idOf(o.subscription) };

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return { kind: "subscription", customerId: idOf(o.customer), subscriptionId: o.id };

    case "invoice.paid":
      return { kind: "invoice_paid", customerId: idOf(o.customer), invoiceId: o.id };

    case "invoice.payment_failed":
      return {
        kind: "invoice_failed",
        customerId: idOf(o.customer),
        invoiceId: o.id,
        detail: `Payment of ${money(o.amount_due, o.currency)} failed` + (o.attempt_count ? ` (attempt ${o.attempt_count})` : ""),
      };

    case "charge.dispute.created":
      return {
        kind: "risk", alertKind: "dispute", objectId: o.id, chargeId: idOf(o.charge), customerId: null,
        detail: `Dispute for ${money(o.amount, o.currency)}${o.reason ? `: ${o.reason}` : ""}`,
      };

    case "charge.refunded":
      // One alert per cumulative refunded amount, so a second partial refund still shows up.
      return {
        kind: "risk", alertKind: "refund", objectId: `${o.id}:${o.amount_refunded}`, chargeId: o.id, customerId: idOf(o.customer),
        detail: `Refunded ${money(o.amount_refunded, o.currency)} of ${money(o.amount, o.currency)}`,
      };

    case "radar.early_fraud_warning.created":
      return {
        kind: "risk", alertKind: "fraud_warning", objectId: o.id, chargeId: idOf(o.charge), customerId: null,
        detail: `Early fraud warning${o.fraud_type ? ` (${o.fraud_type})` : ""}`,
      };

    default:
      return IGNORE;
  }
}
