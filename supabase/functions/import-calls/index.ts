// import-calls (admin only): pulls past phone calls for every linked agent from ElevenLabs
// into public.calls. Used once per new client, or to catch up if the webhook was down.
// Body (optional JSON): { "client_id": "<uuid>", "days": 30 }
import { createClient } from "npm:@supabase/supabase-js@2";
import { mapCall } from "./map.js";

const EL_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function el(path: string) {
  const r = await fetch(`https://api.elevenlabs.io${path}`, { headers: { "xi-api-key": EL_KEY } });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status} on ${path.split("?")[0]}`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!EL_KEY) return json(503, { error: "ELEVENLABS_API_KEY not set" });

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SB_URL, SB_ANON, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: isAdmin } = await userClient.rpc("am_i_admin");
  if (isAdmin !== true) return json(403, { error: "Admins only" });

  const body = await req.json().catch(() => ({}));
  const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  let q = admin.from("clients").select("id, agent_id, business_name").not("agent_id", "is", null);
  if (body.client_id) q = q.eq("id", body.client_id);
  const { data: clients, error } = await q;
  if (error) return json(500, { error: error.message });

  const report: Record<string, { found: number; imported: number }> = {};
  for (const c of clients ?? []) {
    const r = { found: 0, imported: 0 };
    report[c.business_name] = r;
    let cursor = "";
    const ids: string[] = [];
    do {
      const page = await el(`/v1/convai/conversations?agent_id=${c.agent_id}&page_size=100&call_start_after_unix=${since}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      for (const conv of page.conversations ?? []) {
        if (conv.status !== "done") continue;
        if (conv.conversation_initiation_source && conv.conversation_initiation_source !== "twilio") continue;
        ids.push(conv.conversation_id);
      }
      cursor = page.has_more ? page.next_cursor : "";
    } while (cursor);
    r.found = ids.length;

    const { data: existing } = await admin.from("calls").select("conversation_id").in("conversation_id", ids.length ? ids : ["-"]);
    const have = new Set((existing ?? []).map((e) => e.conversation_id));
    for (const id of ids) {
      if (have.has(id)) continue;
      const d = await el(`/v1/convai/conversations/${id}`);
      const row = mapCall(d, c.id);
      // Anything older than 3 days was already handled from the email
      if (Date.parse(row.started_at) < Date.now() - 3 * 86400 * 1000) row.status = "handled";
      const { error: iErr } = await admin.from("calls").upsert(row, { onConflict: "conversation_id", ignoreDuplicates: true });
      if (!iErr) r.imported++;
    }
  }
  return json(200, { days, report });
});
