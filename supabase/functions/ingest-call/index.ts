// ingest-call: stores an ElevenLabs post-call webhook in public.calls.
// Called by n8n (which forwards the original signed body and signature header),
// or directly by ElevenLabs if the webhook is ever pointed here.
// Auth = the ElevenLabs HMAC signature, so verify_jwt is off for this function.
import { createClient } from "npm:@supabase/supabase-js@2";
import { mapCall } from "./map.js";

const SECRET = Deno.env.get("ELEVENLABS_WEBHOOK_SECRET") ?? "";
const MAX_AGE_SECS = 30 * 60;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!SECRET) return json(503, { error: "Signing secret not configured" });

  const raw = await req.text();
  const header = req.headers.get("elevenlabs-signature") ?? "";
  let ts = "", sig = "";
  for (const part of header.split(",")) {
    const p = part.trim();
    if (p.startsWith("t=")) ts = p.slice(2);
    if (p.startsWith("v0=")) sig = p.slice(3);
  }
  if (!ts || !sig) return json(401, { error: "Missing signature" });
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) < MAX_AGE_SECS)) return json(401, { error: "Stale signature" });
  const expected = await hmacHex(SECRET, `${ts}.${raw}`);
  if (!safeEqual(expected, sig)) return json(401, { error: "Bad signature" });

  let body: any;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "Bad JSON" }); }
  if (body?.type !== "post_call_transcription") return json(200, { skipped: "not a transcription event" });
  const d = body.data ?? {};
  if (!d.agent_id || !d.conversation_id) return json(200, { skipped: "no agent or conversation id" });

  const { data: client, error: cErr } = await admin
    .from("clients").select("id").eq("agent_id", d.agent_id).maybeSingle();
  if (cErr) return json(500, { error: cErr.message });
  if (!client) return json(200, { skipped: "agent not linked to a client" });

  const row = mapCall(d, client.id);
  const { error } = await admin.from("calls")
    .upsert(row, { onConflict: "conversation_id", ignoreDuplicates: true });
  if (error) return json(500, { error: error.message });

  return json(200, { stored: row.conversation_id, kind: row.kind });
});
