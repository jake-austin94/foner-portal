// stripe-checkout: makes the Stripe payment link for the end of the free month.
//
// Nothing exists in Stripe until this is called (the free month takes no card). It creates the
// Stripe customer on first use, then a Checkout Session for the monthly (£49) or annual (£490) plan.
//
// Who can call it: a signed-in owner (for their own business) or a foner admin (for any business,
// by passing client_id, so the link can go in the end-of-trial email). It only ever looks the
// business up with the CALLER's own session, so row-level security decides which they may use.
//
// Secrets: STRIPE_SECRET_KEY (restricted key). Optional: SITE_URL (defaults to https://app.foner.uk).
import Stripe from "npm:stripe@23.0.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// `as never`: the SDK's types only list the version it shipped with, but we pin the newest on purpose.
const stripeClient = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2026-10-28.endive" as never });
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = (Deno.env.get("SITE_URL") ?? "https://app.foner.uk").replace(/\/$/, "");

// Prices are found by lookup key, so no Stripe IDs are hard-coded here. scripts/stripe-setup.sh creates them.
const PRICE_KEYS: Record<string, string> = { month: "foner_monthly", year: "foner_annual" };
// A business in any of these already has a subscription; sending it to Checkout again would double-bill.
const HAS_SUBSCRIPTION = ["trialing", "active", "past_due", "unpaid", "paused"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const err = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { ...cors, "Content-Type": "application/json" } });

const suffix = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => String.fromCharCode(97 + (b % 26))).join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return err(405, "POST only");
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return err(503, "Payments aren't switched on yet");

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return err(401, "Sign in required");
  const userClient = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: uErr } = await userClient.auth.getUser(auth.slice(7));
  if (uErr || !u?.user) return err(401, "Sign in required");

  let body: { interval?: string; client_id?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const interval = String(body.interval ?? "");
  if (!PRICE_KEYS[interval]) return err(400, "interval must be 'month' or 'year'");
  if (body.client_id && !/^[0-9a-f-]{36}$/i.test(body.client_id)) return err(400, "Bad client id");

  // Which business? Looked up with the caller's own session, so they can only pick one they can see.
  let q = userClient.from("clients").select("id, business_name, notification_email").limit(2);
  if (body.client_id) q = q.eq("id", body.client_id);
  const { data: found, error: cErr } = await q;
  if (cErr) return err(500, "Couldn't look up the business");
  if (!found?.length) return err(404, "Business not found");
  if (found.length > 1) return err(400, "Say which business (client_id)");
  const biz = found[0];

  const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
  const { data: bill, error: bErr } = await db.from("billing").select("stripe_customer_id, status").eq("client_id", biz.id).maybeSingle();
  if (bErr) return err(500, "Couldn't read billing");
  if (bill && HAS_SUBSCRIPTION.includes(bill.status)) return err(409, "This business already has a subscription. Use Manage billing to change it.");

  try {
    const prices = await stripeClient.prices.list({ lookup_keys: [PRICE_KEYS[interval]], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) return err(503, "Plans aren't set up in Stripe yet");

    let customerId = bill?.stripe_customer_id ?? null;
    // If the saved customer was deleted in Stripe, forget it and start fresh instead of failing.
    if (customerId) {
      try {
        const existing = await stripeClient.customers.retrieve(customerId);
        if ((existing as { deleted?: boolean }).deleted) customerId = null;
      } catch (e) {
        if ((e as { code?: string })?.code === "resource_missing") customerId = null; else throw e;
      }
    }
    if (!customerId) {
      // The idempotency key stops two quick taps from creating two Stripe customers. It is per minute so a
      // customer that was deleted in Stripe can be created again (Stripe replays a key's answer for 24 hours).
      const customer = await stripeClient.customers.create(
        { name: biz.business_name, ...(biz.notification_email ? { email: biz.notification_email } : {}) },
        { idempotencyKey: `foner-customer-${biz.id}-${Math.floor(Date.now() / 60000)}` },
      );
      customerId = customer.id;
      // Our own mapping (not Stripe metadata) is how webhooks find this business again.
      const { error: sErr } = await db.from("billing").upsert(
        { client_id: biz.id, stripe_customer_id: customerId, stripe_subscription_id: null, status: "none", billing_interval: null, current_period_end: null, cancel_at_period_end: false },
        { onConflict: "client_id" },
      );
      if (sErr) throw sErr;
    }

    // No payment_method_types on purpose: Stripe shows the methods switched on in the Dashboard.
    const session = await stripeClient.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${SITE}/?billing=success#/account`,
      cancel_url: `${SITE}/?billing=cancelled#/account`,
      integration_identifier: `foner-portal-${suffix()}`,
    });
    return new Response(JSON.stringify({ url: session.url }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("stripe-checkout", e);
    return err(502, "Couldn't start payment right now. Try again in a minute.");
  }
});
