// push: foner's phone notifications.
//
//   POST { action: "key" }                     public VAPID key for the portal
//   POST { action: "test" }                    signed-in user: test notification to their own devices
//   POST { action: "call", call_id }           new call (database trigger, x-foner-key)
//   POST { action: "signin", member_id, dry? } customer's first portal open: tells foner admins' devices (database trigger, x-foner-key)
//   POST { action: "run", dry?, at?, all? }    reminders (cron, x-foner-key): needs a price at 6pm UK, chase at 8am UK.
//                                              `at` and `all` (every active business) only work with dry: nothing is sent.
//
// Businesses only get these with clients.push_enabled on. push_log stops anything going twice.
// The VAPID key pair is created here on first use and kept in private.secrets.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { ukParts, priceDue, chaseDue, callMessage, priceMessage, priceSummary, chaseMessage, chaseSummary, PRICE_HOUR, CHASE_HOUR, MAX_SINGLE } from "./rules.js";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SUBJECT = "mailto:foner.uk@gmail.com";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...CORS } });

type Msg = { title: string; body: string; url: string; tag: string };
type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

let cfg: { push_key: string; vapid_public: string; vapid_private: string } | null = null;
async function config() {
  if (cfg) return cfg;
  const { data, error } = await db.rpc("push_config");
  if (error || !data?.push_key) throw new Error("push config missing");
  if (!data.vapid_public) {
    const k = webpush.generateVAPIDKeys();
    const { error: e } = await db.rpc("push_store_vapid", { p_public: k.publicKey, p_private: k.privateKey });
    if (e) { const { data: again } = await db.rpc("push_config"); cfg = again; } // another request got there first
    else cfg = { push_key: data.push_key, vapid_public: k.publicKey, vapid_private: k.privateKey };
  } else cfg = data;
  webpush.setVapidDetails(SUBJECT, cfg!.vapid_public, cfg!.vapid_private);
  return cfg!;
}

async function deliver(subs: Sub[], msg: Msg, urgency: "high" | "normal") {
  await config();
  const payload = JSON.stringify(msg);
  const out = await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency });
      await db.from("push_subscriptions").update({ last_sent_at: new Date().toISOString() }).eq("id", s.id);
      return true;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id); // phone has dropped it
      else console.error("push failed", code, (e as { body?: string }).body ?? String(e));
      return false;
    }
  }));
  return { sent: out.filter(Boolean).length, failed: out.filter((x) => !x).length };
}

const subsFor = async (clientId: string) =>
  ((await db.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("client_id", clientId)).data ?? []) as Sub[];

// True the first time only.
async function claim(clientId: string, kind: string, ref: string, slot: string) {
  const { error } = await db.from("push_log").insert({ client_id: clientId, kind, ref_id: ref, slot });
  if (error && error.code !== "23505") throw error;
  return !error;
}

async function onCall(callId: string) {
  const { data: c } = await db.from("calls").select("id,client_id,kind,hidden_reason,caller_name,caller_number,caller_id_number,summary,clients(push_enabled,active)").eq("id", callId).maybeSingle();
  const client = (c as any)?.clients;
  if (!c || !client?.push_enabled || !client?.active || c.kind === "silent" || c.hidden_reason) return { skipped: true };
  const subs = await subsFor(c.client_id);
  if (!subs.length) return { skipped: "no devices" };
  if (!(await claim(c.client_id, "call", c.id, ""))) return { skipped: "already sent" };
  return deliver(subs, callMessage(c), "high");
}

async function onSignin(memberId: string, dry: boolean) {
  const { data: m } = await db.from("client_members").select("id,client_id,email,clients(business_name,owner_name)").eq("id", memberId).maybeSingle();
  if (!m) return { skipped: "unknown member" };
  const client = (m as any).clients;
  const admins = ((await db.from("admins").select("email")).data ?? []).map((a: { email: string }) => a.email);
  const subs = ((await db.from("push_subscriptions").select("id,endpoint,p256dh,auth").in("email", admins)).data ?? []) as Sub[];
  const msg: Msg = { title: `${client.owner_name || client.business_name} has opened foner`, body: `${client.business_name} is in their portal for the first time.`, url: "#/admin", tag: `signin-${m.id}` };
  if (dry) return { would_send: msg, devices: subs.length };
  if (!subs.length) return { skipped: "no devices" };
  if (!(await claim(m.client_id, "signin", m.id, ""))) return { skipped: "already sent" };
  return deliver(subs, msg, "high");
}

async function sendBatch(clientId: string, subs: Sub[], kind: "price" | "chase", slot: string, items: { ref: string; msg: Msg }[], summary: Msg, dry: boolean, report: unknown[]) {
  if (dry) { report.push({ client: clientId, kind, would_send: items.length > MAX_SINGLE ? [summary.title] : items.map((i) => i.msg.title) }); return; }
  const fresh: { ref: string; msg: Msg }[] = [];
  for (const i of items) if (await claim(clientId, kind, i.ref, slot)) fresh.push(i);
  if (!fresh.length) return;
  const msgs = fresh.length > MAX_SINGLE ? [summary] : fresh.map((i) => i.msg);
  for (const m of msgs) report.push({ client: clientId, kind, title: m.title, ...(await deliver(subs, m, "normal")) });
}

async function run(now: Date, dry: boolean, all: boolean) {
  const { date, hour } = ukParts(now);
  const report: unknown[] = [];
  if (hour !== PRICE_HOUR && hour !== CHASE_HOUR) return { date, hour, report };
  let q = db.from("clients").select("id,business_name").eq("active", true);
  if (!(dry && all)) q = q.eq("push_enabled", true);
  for (const c of (await q).data ?? []) {
    const subs = await subsFor(c.id);
    if (!subs.length && !dry) continue;
    if (hour === PRICE_HOUR) {
      const { data: jobs } = await db.from("jobs").select("id,stage,quote_amount,created_at,customer:customers(name,phone)").eq("client_id", c.id).in("stage", ["new", "visit_booked"]).is("quote_amount", null);
      if (!jobs?.length) continue;
      const ids = jobs.map((j) => j.id);
      const { data: visits } = await db.from("events").select("job_id,starts_at,done").eq("kind", "quote_visit").in("job_id", ids);
      const { data: log } = await db.from("push_log").select("ref_id,sent_at").eq("kind", "price").in("ref_id", ids);
      const due = priceDue(jobs, visits ?? [], log ?? [], now);
      if (due.length) await sendBatch(c.id, subs, "price", date, due.map((j: any) => ({ ref: j.id, msg: priceMessage(j) })), priceSummary(due.length), dry, report);
    } else {
      const { data: events } = await db.from("events").select("id,kind,done,title,starts_at,job_id,customer:customers(name,phone),job:jobs(stage,quote_amount)").eq("client_id", c.id).eq("kind", "callback").eq("done", false)
        .gte("starts_at", new Date(now.getTime() - 86400000).toISOString()).lte("starts_at", new Date(now.getTime() + 86400000).toISOString());
      const due = chaseDue(events ?? [], date);
      if (due.length) await sendBatch(c.id, subs, "chase", date, due.map((e: any) => ({ ref: e.id, msg: chaseMessage(e) })), chaseSummary(due.length), dry, report);
    }
  }
  return { date, hour, report };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const k = await config();

    if (body.action === "key") return json({ key: k.vapid_public });

    if (body.action === "test") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = await db.auth.getUser(token);
      if (!user?.email) return json({ error: "sign in first" }, 401);
      const { data } = await db.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("email", user.email.toLowerCase());
      if (!data?.length) return json({ ok: false, error: "no devices" }, 404);
      const r = await deliver(data as Sub[], { title: "foner notifications are on", body: "New calls, jobs that need a price and quotes to chase will show up here.", url: "#/account", tag: "test" }, "high");
      return json({ ok: r.sent > 0, ...r });
    }

    if ((req.headers.get("x-foner-key") ?? "") !== k.push_key) return json({ error: "unauthorised" }, 401);
    if (body.action === "call") return json(await onCall(String(body.call_id)));
    if (body.action === "signin") return json(await onSignin(String(body.member_id), body.dry === true));
    if (body.action === "run") {
      const dry = body.dry === true;
      return json(await run(dry && body.at ? new Date(body.at) : new Date(), dry, body.all === true));
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
