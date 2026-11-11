// stripe-webhook: Stripe tells us what happened (signed up, renewed, card failed, disputed...).
// Deploy this one with JWT verification OFF (Stripe isn't a signed-in user); the Stripe
// signature below is the authentication.
//
// Secrets: STRIPE_SECRET_KEY (a restricted key, see BILLING.md), STRIPE_WEBHOOK_SECRET (whsec_...).
// What to do with each event type lives in logic.js, which has its own tests.
import Stripe from "npm:stripe@23.0.0";
import { createClient } from "npm:@supabase/supabase-js@2";
import { planEvent, mapSubscription } from "./logic.js";

// `as never`: the SDK's types only list the version it shipped with, but we pin the newest on purpose.
const stripeClient = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2026-10-28.endive" as never });
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function clientIdForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const { data, error } = await db.from("billing").select("client_id").eq("stripe_customer_id", customerId).maybeSingle();
  if (error) throw error;
  return data?.client_id ?? null;
}

// One alert per (kind, Stripe object): a re-delivered event can't create a second one.
async function raiseAlert(clientId: string | null, kind: string, objectId: string, detail: string) {
  const { error } = await db.from("billing_alerts")
    .upsert({ client_id: clientId, kind, stripe_object_id: objectId, detail }, { onConflict: "kind,stripe_object_id", ignoreDuplicates: true });
  if (error) throw error;
}

async function handle(event: Stripe.Event) {
  const plan = planEvent(event);

  if (plan.kind === "ignore") return;

  if (plan.kind === "subscription") {
    if (!plan.subscriptionId) return; // a checkout with no subscription attached: nothing to mirror
    const clientId = await clientIdForCustomer(plan.customerId);
    if (!clientId) {
      await raiseAlert(null, "unknown_customer", plan.customerId ?? plan.subscriptionId, `Subscription ${plan.subscriptionId} belongs to a Stripe customer foner doesn't know`);
      return;
    }
    // Events can arrive out of order, so don't trust the one we were sent: ask Stripe for the current state.
    const sub = await stripeClient.subscriptions.retrieve(plan.subscriptionId);
    const { error } = await db.from("billing").update(mapSubscription(sub)).eq("client_id", clientId);
    if (error) throw error;
    return;
  }

  if (plan.kind === "invoice_paid") {
    const clientId = await clientIdForCustomer(plan.customerId);
    if (!clientId) return;
    const { error } = await db.from("billing_alerts")
      .update({ resolved_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("kind", "payment_failed").is("resolved_at", null);
    if (error) throw error;
    return;
  }

  if (plan.kind === "invoice_failed") {
    const clientId = await clientIdForCustomer(plan.customerId);
    await raiseAlert(clientId, "payment_failed", plan.invoiceId, plan.detail);
    return;
  }

  if (plan.kind === "risk") {
    // Disputes and fraud warnings only know the charge; the charge knows the customer.
    let customerId = plan.customerId;
    if (!customerId && plan.chargeId) {
      const charge = await stripeClient.charges.retrieve(plan.chargeId);
      customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null;
    }
    await raiseAlert(await clientIdForCustomer(customerId), plan.alertKind, plan.objectId, plan.detail);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  if (!WEBHOOK_SECRET) return reply(503, { error: "Billing isn't switched on yet" });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return reply(400, { error: "Missing signature" });

  // The signature is over the exact bytes Stripe sent, so read the raw text before anything parses it.
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripeClient.webhooks.constructEventAsync(raw, signature, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch {
    return reply(400, { error: "Bad signature" });
  }

  // Stripe retries, so the same event can arrive more than once. Record it first.
  const { error: insertError } = await db.from("stripe_events").insert({ id: event.id, type: event.type });
  if (insertError) {
    if (insertError.code !== "23505") return reply(500, { error: "Couldn't record event" });
    const { data: seen } = await db.from("stripe_events").select("processed_at").eq("id", event.id).maybeSingle();
    if (seen?.processed_at) return reply(200, { duplicate: true });
    // Seen before but it failed last time: try again.
  }

  try {
    await handle(event);
    await db.from("stripe_events").update({ processed_at: new Date().toISOString(), error: null }).eq("id", event.id);
    return reply(200, { ok: true });
  } catch (e) {
    console.error("stripe-webhook", event.type, e);
    await db.from("stripe_events").update({ error: String((e as Error)?.message ?? e).slice(0, 500) }).eq("id", event.id);
    // A non-2xx makes Stripe retry later.
    return reply(500, { error: "Handler failed" });
  }
});
