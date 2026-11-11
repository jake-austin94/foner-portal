// stripe-portal: opens Stripe's own Customer Portal so a customer can update their card,
// see invoices, switch monthly/annual or cancel, without us building any of that.
//
// Same rules as stripe-checkout: the business is looked up with the CALLER's own session, so
// an owner can only open their own, and a foner admin can open any by passing client_id.
//
// Needs a saved Customer Portal configuration in Stripe (scripts/stripe-setup.sh makes one).
// Secrets: STRIPE_SECRET_KEY (restricted key). Optional: SITE_URL.
import Stripe from "npm:stripe@23.0.0";
import { createClient } from "npm:@supabase/supabase-js@2";

// `as never`: the SDK's types only list the version it shipped with, but we pin the newest on purpose.
const stripeClient = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2026-10-28.endive" as never });
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = (Deno.env.get("SITE_URL") ?? "https://app.foner.uk").replace(/\/$/, "");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const err = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return err(405, "POST only");
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return err(503, "Payments aren't switched on yet");

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return err(401, "Sign in required");
  const userClient = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: uErr } = await userClient.auth.getUser(auth.slice(7));
  if (uErr || !u?.user) return err(401, "Sign in required");

  let body: { client_id?: string } = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }
  if (body.client_id && !/^[0-9a-f-]{36}$/i.test(body.client_id)) return err(400, "Bad client id");

  let q = userClient.from("clients").select("id").limit(2);
  if (body.client_id) q = q.eq("id", body.client_id);
  const { data: found, error: cErr } = await q;
  if (cErr) return err(500, "Couldn't look up the business");
  if (!found?.length) return err(404, "Business not found");
  if (found.length > 1) return err(400, "Say which business (client_id)");

  const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });
  const { data: bill, error: bErr } = await db.from("billing").select("stripe_customer_id").eq("client_id", found[0].id).maybeSingle();
  if (bErr) return err(500, "Couldn't read billing");
  if (!bill?.stripe_customer_id) return err(404, "No billing set up for this business yet");

  try {
    const session = await stripeClient.billingPortal.sessions.create({
      customer: bill.stripe_customer_id,
      return_url: `${SITE}/#/account`,
    });
    return new Response(JSON.stringify({ url: session.url }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("stripe-portal", e);
    return err(502, "Couldn't open billing right now. Try again in a minute.");
  }
});
