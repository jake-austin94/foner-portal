// stripe-invoice-item: a foner admin adds a 30-minute top-up (£10) to a customer's Stripe invoice.
//
//   { client_id, packs: 1 }          packs of 30 minutes; optional invoice_now, request_id
//
// The top-up is added as a Stripe invoice item. For a monthly subscriber it joins their next
// invoice. An annual subscriber's next invoice could be a year away, so for them (or with
// invoice_now: true) an invoice is created straight away and Stripe charges the saved card.
//
// Admins only. Secrets: STRIPE_SECRET_KEY (restricted key).
import Stripe from "npm:stripe@23.0.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// `as never`: the SDK's types only list the version it shipped with, but we pin the newest on purpose.
const stripeClient = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2026-10-28.endive" as never });
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TOPUP_MINUTES = 30; // minutes in one top-up pack (the price is set in Stripe: foner_topup_30)
const MAX_PACKS = 20;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return json(503, { error: "Payments aren't switched on yet" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Sign in required" });
  const userClient = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: uErr } = await userClient.auth.getUser(auth.slice(7));
  if (uErr || !u?.user) return json(401, { error: "Sign in required" });
  const { data: isAdmin } = await userClient.rpc("am_i_admin");
  if (isAdmin !== true) return json(403, { error: "foner admins only" });

  let body: { client_id?: string; packs?: number; invoice_now?: boolean; request_id?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  if (!body.client_id || !/^[0-9a-f-]{36}$/i.test(body.client_id)) return json(400, { error: "client_id required" });
  const packs = Number(body.packs ?? 1);
  if (!Number.isInteger(packs) || packs < 1 || packs > MAX_PACKS) return json(400, { error: `packs must be a whole number from 1 to ${MAX_PACKS}` });

  const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
  const { data: bill, error: bErr } = await db.from("billing")
    .select("stripe_customer_id, billing_interval").eq("client_id", body.client_id).maybeSingle();
  if (bErr) return json(500, { error: "Couldn't read billing" });
  if (!bill?.stripe_customer_id) return json(404, { error: "This business has no Stripe customer yet. Send them their payment link first." });

  try {
    const prices = await stripeClient.prices.list({ lookup_keys: ["foner_topup_30"], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) return json(503, { error: "The top-up price isn't set up in Stripe yet" });

    const minutes = packs * TOPUP_MINUTES;
    // A repeat of the same request (a double tap) reuses the same Stripe item instead of billing twice.
    const key = `foner-topup-${body.client_id}-${body.request_id ?? crypto.randomUUID()}`;

    const item = await stripeClient.invoiceItems.create(
      { customer: bill.stripe_customer_id, pricing: { price: price.id }, quantity: packs, description: `Top-up: ${minutes} extra call minutes` },
      { idempotencyKey: key },
    );

    const { error: chargeErr } = await db.from("billing_charges").insert({
      client_id: body.client_id, minutes, quantity: packs, stripe_invoice_item_id: item.id,
    });
    // 23505 = a double tap: Stripe handed back the same item and it's already recorded.
    if (chargeErr && chargeErr.code !== "23505") throw chargeErr;

    // Annual subscribers (or an explicit request): invoice now rather than waiting for next year's renewal.
    let invoiceId: string | null = null;
    if (body.invoice_now === true || bill.billing_interval === "year") {
      const invoice = await stripeClient.invoices.create(
        { customer: bill.stripe_customer_id, pending_invoice_items_behavior: "include", auto_advance: true },
        { idempotencyKey: `${key}-invoice` },
      );
      invoiceId = invoice.id;
    }

    return json(200, {
      created: true, minutes, quantity: packs, invoice_item: item.id, invoice: invoiceId,
      timing: invoiceId ? "Invoiced now; Stripe will charge the saved card shortly" : "Added to their next invoice",
    });
  } catch (e) {
    console.error("stripe-invoice-item", e);
    return json(502, { error: "Couldn't add the charge in Stripe. Nothing may have been billed; check Stripe before trying again." });
  }
});
