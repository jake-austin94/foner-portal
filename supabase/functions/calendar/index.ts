// calendar: a private iCalendar (.ics) feed of one business's bookings, for
// subscribing in Apple Calendar / Google Calendar. The unguessable per-business
// token in the URL is the only key, so verify_jwt is off for this function.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const KIND: Record<string, string> = { quote_visit: "Quote visit", job: "Job", callback: "Call back" };

const esc = (s: unknown) =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

// Fold long lines at 75 octets as RFC 5545 asks
function fold(line: string) {
  const out: string[] = [];
  let s = line;
  while (s.length > 74) { out.push(s.slice(0, 74)); s = " " + s.slice(74); }
  out.push(s);
  return out.join("\r\n");
}

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Not found", { status: 404 });

  const { data: client } = await admin.from("clients").select("id, business_name").eq("calendar_token", token).maybeSingle();
  if (!client) return new Response("Not found", { status: 404 });

  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: events } = await admin
    .from("events")
    .select("id, kind, title, starts_at, ends_at, all_day, address, notes, done, updated_at, customers(name, phone), jobs(service)")
    .eq("client_id", client.id)
    .gte("starts_at", since)
    .order("starts_at")
    .limit(1000);

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//foner//portal//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(client.business_name + " (foner)")}`, "X-WR-TIMEZONE:Europe/London",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  const now = stamp(new Date());
  for (const e of events ?? []) {
    const cust = (e as any).customers || {};
    const svc = (e as any).jobs?.service;
    const who = cust.name || cust.phone || "";
    const summary = `${e.done ? "✓ " : ""}${KIND[e.kind] || "Booking"}${who ? `: ${who}` : ""}${e.title ? ` - ${e.title}` : svc ? ` - ${svc}` : ""}`;
    const start = new Date(e.starts_at);
    const desc = [cust.phone ? `Phone: ${cust.phone}` : "", e.notes || "", "Open in foner: https://app.foner.uk/#/calendar"].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@foner.uk`, `DTSTAMP:${now}`, `LAST-MODIFIED:${stamp(new Date(e.updated_at))}`);
    if (e.all_day) {
      const end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 86400000);
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(start)}`, `DTEND;VALUE=DATE:${dateOnly(end > start ? end : new Date(start.getTime() + 86400000))}`);
    } else {
      const end = e.ends_at ? new Date(e.ends_at) : new Date(start.getTime() + 3600000);
      lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
    }
    lines.push(`SUMMARY:${esc(summary)}`);
    if (e.address) lines.push(`LOCATION:${esc(e.address)}`);
    lines.push(`DESCRIPTION:${esc(desc)}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="foner.ics"',
      "Cache-Control": "no-store",
    },
  });
});
