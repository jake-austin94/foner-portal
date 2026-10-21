// call-audio: streams a call recording from ElevenLabs to a signed-in portal user.
// The user's own session decides access: we look the call up with THEIR token,
// so row-level security only returns calls for businesses they belong to.
import { createClient } from "npm:@supabase/supabase-js@2";

const EL_KEY = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function err(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return err(405, "GET only");
  if (!EL_KEY) return err(503, "Recordings are not switched on yet");

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return err(401, "Sign in required");

  const userClient = createClient(SB_URL, SB_ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: u, error: uErr } = await userClient.auth.getUser(auth.slice(7));
  if (uErr || !u?.user) return err(401, "Sign in required");

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return err(400, "Bad call id");

  const { data: call, error: cErr } = await userClient
    .from("calls").select("conversation_id").eq("id", id).maybeSingle();
  if (cErr) return err(500, cErr.message);
  if (!call) return err(404, "Call not found");

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(call.conversation_id)}/audio`,
    { headers: { "xi-api-key": EL_KEY } },
  );
  if (upstream.status === 404) return err(404, "No recording stored for this call");
  if (!upstream.ok || !upstream.body) return err(502, "Recording unavailable right now");

  return new Response(upstream.body, {
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") ?? "audio/mpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
});
