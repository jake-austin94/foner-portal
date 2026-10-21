// foner customer portal — plain JS, no build step.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, SUPPORT_EMAIL } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const TZ = "Europe/London";
const LIST_COLS =
  "id,client_id,started_at,duration_secs,kind,title,summary,caller_name,caller_number,caller_id_number,address,caller_email,service,quote_method,visit_preference,notes,ended_reason,status,handled_at,handled_by,source,customer_id,job_id,read_at,hidden_reason";

const state = {
  session: null,
  email: "",
  isAdmin: false,
  clients: [],
  clientId: null,
  calls: [],
  callsFor: null,
  requests: [],
  requestsFor: null,
  customers: [],
  jobs: [],
  events: [],
  crmFor: null,
  channel: null,
  filter: "todo",
  query: "",
  jobFilter: "active",
  jobQuery: "",
  custQuery: "",
  calStart: null, // London day key for the first day shown in the calendar
  moneyPeriod: "month",
  recovery: false,
};

const app = document.getElementById("app");
const desktop = window.matchMedia("(min-width: 960px)");

// ---------- small helpers ----------
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const client = () => state.clients.find((c) => c.id === state.clientId) || null;
const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";

function toast(msg, ms = 3200) {
  const t = document.getElementById("toast");
  t.innerHTML = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

const KIND = {
  enquiry: "New enquiry",
  message: "Message",
  no_details: "No details given",
  silent: "Silent call",
  other: "Other call",
};
const STATUS = { pending: "Sent", in_progress: "Being worked on", done: "Done", declined: "Not changed" };

function numberOf(c) {
  // A stated number is only trusted if it's a whole UK number; otherwise use caller ID
  const stated = String(c.caller_number || "").replace(/\D/g, "");
  return stated.length >= 10 ? c.caller_number : c.caller_id_number || c.caller_number || "";
}
function digits(s) { return String(s || "").replace(/[^0-9+]/g, ""); }
function prettyNumber(n) {
  const d = String(n || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("07")) return `${d.slice(0, 5)} ${d.slice(5)}`;
  if (d.length === 11 && d.startsWith("01")) return `${d.slice(0, 5)} ${d.slice(5)}`;
  if (d.length === 11 && d.startsWith("02")) return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  return n || "";
}
function waLink(n) {
  const d = String(n || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("07") ? `https://wa.me/44${d.slice(1)}` : "";
}
function displayName(c) {
  return c.caller_name || (numberOf(c) ? prettyNumber(numberOf(c)) : "Unknown caller");
}
function whatLine(c) {
  return c.service ? cap(c.service) : c.title || KIND[c.kind] || "Call";
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
function shortAddress(a) {
  if (!a) return "";
  return a.length > 48 ? a.slice(0, 46) + "…" : a;
}

const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const longFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function ago(iso) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const today = dayKey(new Date());
  const yest = dayKey(new Date(Date.now() - 86400000));
  if (dayKey(d) === today) return timeFmt.format(d);
  if (dayKey(d) === yest) return `Yesterday ${timeFmt.format(d)}`;
  return dayFmt.format(d);
}
function dayLabel(iso) {
  const d = new Date(iso);
  if (dayKey(d) === dayKey(new Date())) return "Today";
  if (dayKey(d) === dayKey(new Date(Date.now() - 86400000))) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(d);
}
function dur(s) {
  s = Number(s) || 0;
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} sec` : `${m} min`;
}
function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function monthStart() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date());
  return new Date(`${parts}-01T00:00:00`);
}
const gbp = (n) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(Number(n) || 0);

// ---------- CRM vocabulary ----------
const STAGES = {
  new: "New enquiry",
  visit_booked: "Quote visit booked",
  quoted: "Quoted",
  won: "Won",
  booked: "Job booked",
  completed: "Completed",
  lost: "Lost",
};
const STAGE_ORDER = ["new", "visit_booked", "quoted", "won", "booked", "completed"];
const OPEN_STAGES = ["new", "visit_booked", "quoted", "won", "booked"];
const EVENT_KIND = { quote_visit: "Quote visit", job: "Job", callback: "Call back" };
const SOURCES = {
  foner_call: "foner call",
  phone: "Phone (direct)",
  whatsapp: "WhatsApp",
  facebook: "Facebook",
  website: "Website",
  referral: "Referral",
  repeat: "Repeat customer",
  other: "Other",
};
const LOST_REASONS = ["Too expensive", "Went with someone else", "No reply", "Not something we do", "Other"];

// ---------- dates (all shown in UK time) ----------
const todayKey = () => dayKey(new Date());
function addDays(key, n) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function londonISO(dateKey, time) {
  // Turn a UK wall-clock date + time into a UTC timestamp, allowing for BST
  const guess = new Date(`${dateKey}T${time}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(guess).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (wall - guess.getTime())).toISOString();
}
const noonISO = (key) => `${key}T12:00:00.000Z`; // all-day events are stored at midday UTC
function eventDays(e) {
  if (!e.all_day) return [dayKey(new Date(e.starts_at))];
  const first = e.starts_at.slice(0, 10);
  const end = e.ends_at ? e.ends_at.slice(0, 10) : addDays(first, 1);
  const out = [];
  for (let k = first; k < end && out.length < 31; k = addDays(k, 1)) out.push(k);
  return out.length ? out : [first];
}
function prettyDay(key, withYear = false) {
  if (key === todayKey()) return "Today";
  if (key === addDays(todayKey(), 1)) return "Tomorrow";
  if (key === addDays(todayKey(), -1)) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) })
    .format(new Date(`${key}T12:00:00Z`));
}
function eventTime(e) {
  if (e.all_day) {
    const days = eventDays(e).length;
    return days > 1 ? `${days} days` : "All day";
  }
  return timeFmt.format(new Date(e.starts_at));
}
function mondayOf(key) {
  const d = new Date(`${key}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(key, -dow);
}
const inputDate = (key) => key; // <input type=date> already uses YYYY-MM-DD

// ---------- CRM lookups ----------
const customerById = (id) => state.customers.find((c) => c.id === id) || null;
const jobById = (id) => state.jobs.find((j) => j.id === id) || null;
const jobValue = (j) => Number(j.won_amount ?? j.quote_amount ?? 0);
function custName(cu) { return cu?.name || (cu?.phone ? prettyNumber(cu.phone) : "Unnamed customer"); }
function nextEventFor(jobId) {
  const now = Date.now() - 3600000;
  return state.events
    .filter((e) => e.job_id === jobId && !e.done && new Date(e.ends_at || e.starts_at).getTime() >= now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] || null;
}
const live = (c) => !c.hidden_reason; // spam/test calls are hidden from lists and stats
const unread = () => state.calls.filter((c) => live(c) && !c.read_at && c.kind !== "silent");

// ---------- icons ----------
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  calls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M19.5 19c0 1.5-2 2.5-5 2.5"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.1-1.8-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.4-.5c.2-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5.1 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.3-.6-.4zM12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
};

// ---------- data ----------
async function loadClients() {
  const { data, error } = await sb.from("clients").select("*").order("business_name");
  if (error) throw error;
  state.clients = data || [];
  const saved = store.get("foner.client");
  state.clientId = state.clients.find((c) => c.id === saved)?.id || state.clients[0]?.id || null;
}

async function loadCalls(force = false) {
  if (!state.clientId) return;
  if (!force && state.callsFor === state.clientId) return;
  const { data, error } = await sb
    .from("calls").select(LIST_COLS)
    .eq("client_id", state.clientId)
    .order("started_at", { ascending: false })
    .limit(400);
  if (error) throw error;
  state.calls = data || [];
  state.callsFor = state.clientId;
}

async function loadRequests(force = false) {
  if (!state.clientId) return;
  if (!force && state.requestsFor === state.clientId) return;
  const { data, error } = await sb
    .from("change_requests").select("*")
    .eq("client_id", state.clientId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  state.requests = data || [];
  state.requestsFor = state.clientId;
}

async function loadCRM(force = false) {
  if (!state.clientId) return;
  if (!force && state.crmFor === state.clientId) return;
  const since = new Date(Date.now() - 400 * 86400000).toISOString();
  const [cu, jo, ev] = await Promise.all([
    sb.from("customers").select("*").eq("client_id", state.clientId).order("created_at", { ascending: false }).limit(2000),
    sb.from("jobs").select("*").eq("client_id", state.clientId).order("created_at", { ascending: false }).limit(2000),
    sb.from("events").select("*").eq("client_id", state.clientId).gte("starts_at", since).order("starts_at").limit(3000),
  ]);
  if (cu.error || jo.error || ev.error) throw cu.error || jo.error || ev.error;
  state.customers = cu.data || [];
  state.jobs = jo.data || [];
  state.events = ev.data || [];
  state.crmFor = state.clientId;
}

// Small write helpers that keep the local copy in step
async function save(table, id, patch) {
  const { data, error } = await sb.from(table).update(patch).eq("id", id).select().single();
  if (error) { toast(`Couldn't save: ${esc(error.message)}`); return null; }
  const list = state[table];
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = data;
  return data;
}
async function create(table, row) {
  const { data, error } = await sb.from(table).insert({ client_id: state.clientId, ...row }).select().single();
  if (error) { toast(`Couldn't save: ${esc(error.message)}`); return null; }
  if (table === "events") { state.events.push(data); state.events.sort((a, b) => a.starts_at.localeCompare(b.starts_at)); }
  else state[table].unshift(data);
  return data;
}
async function remove(table, id) {
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) { toast(`Couldn't delete: ${esc(error.message)}`); return false; }
  state[table] = state[table].filter((x) => x.id !== id);
  return true;
}

function subscribe() {
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  if (!state.clientId) return;
  state.channel = sb
    .channel(`calls-${state.clientId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "calls", filter: `client_id=eq.${state.clientId}` }, (p) => {
      const row = p.new;
      if (!row || state.calls.some((c) => c.id === row.id)) return;
      state.calls.unshift(row);
      if (row.kind !== "silent") toast(`New call: ${esc(displayName(row))}. <a href="#/calls/${row.id}">Open</a>`, 6000);
      // The database links the call to a customer and job a moment later
      setTimeout(async () => { await loadCRM(true).catch(() => {}); route(); }, 1500);
      route();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "calls", filter: `client_id=eq.${state.clientId}` }, (p) => {
      const i = state.calls.findIndex((c) => c.id === p.new.id);
      if (i >= 0) {
        const keep = { status: state.calls[i].status, read_at: state.calls[i].read_at };
        state.calls[i] = { ...state.calls[i], ...p.new };
        if (p.new.status === undefined) Object.assign(state.calls[i], keep);
      }
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "change_requests", filter: `client_id=eq.${state.clientId}` }, (p) => {
      const i = state.requests.findIndex((r) => r.id === p.new.id);
      if (i >= 0) { state.requests[i] = p.new; if (location.hash.startsWith("#/agent")) route(); }
    })
    .subscribe();
}

const todo = () => state.calls.filter((c) => live(c) && c.status === "new" && c.kind !== "silent");

async function setHandled(id, handled) {
  const call = state.calls.find((c) => c.id === id);
  const prev = call?.status;
  if (call) call.status = handled ? "handled" : "new";
  route();
  const { error } = await sb.from("calls").update({ status: handled ? "handled" : "new" }).eq("id", id);
  if (error) {
    if (call) call.status = prev;
    route();
    toast("Couldn't update that call. Check your connection and try again.");
    return;
  }
  toast(handled
    ? `Marked as done. <button class="link" style="color:inherit" data-undo="${id}">Undo</button>`
    : "Moved back to your to-do list.", 5000);
}

// ---------- layout ----------
function nav(active) {
  const n = unread().length;
  const railItems = [
    ["home", "#/", "Home", I.home],
    ["calls", "#/calls", "Calls", I.calls],
    ["jobs", "#/jobs", "Jobs", I.jobs],
    ["calendar", "#/calendar", "Calendar", I.calendar],
    ["customers", "#/customers", "Customers", I.account],
    ["money", "#/money", "What foner made you", I.money],
    ["agent", "#/agent", "Receptionist", I.agent],
    ["account", "#/account", "Account", I.gear],
  ];
  if (state.isAdmin) railItems.push(["admin", "#/admin", "Admin", I.admin]);
  const tabItems = [
    ["home", "#/", "Home", I.home],
    ["calls", "#/calls", "Calls", I.calls],
    ["jobs", "#/jobs", "Jobs", I.jobs],
    ["calendar", "#/calendar", "Calendar", I.calendar],
    ["more", "#/more", "More", I.more],
  ];
  const tabActive = ["customers", "money", "agent", "account", "admin", "more"].includes(active) ? "more" : active;
  const link = ([k, href, label, icon], cur, rail) =>
    `<a href="${href}" ${k === cur ? 'aria-current="page"' : ""}>${icon}<span>${label}</span>${
      k === "calls" && n ? `<span class="dot" aria-label="${n} unread">${n}</span>` : ""
    }</a>`;
  return {
    rail: `<nav class="rail" aria-label="Main">${railItems.map((i) => link(i, active, true)).join("")}<div class="foot">Need a hand? <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></div></nav>`,
    tabs: `<nav class="tabs" aria-label="Main">${tabItems.map((i) => link(i, tabActive, false)).join("")}</nav>`,
  };
}

function topbar() {
  const c = client();
  const switcher = state.clients.length > 1
    ? `<label class="sr-only" for="biz">Business</label><select id="biz" class="biz-select" style="margin-left:auto">${state.clients
        .map((x) => `<option value="${x.id}" ${x.id === state.clientId ? "selected" : ""}>${esc(x.business_name)}</option>`).join("")}</select>`
    : `<span class="biz">${esc(c?.business_name || "")}</span>`;
  return `<header class="topbar">
    <a href="#/" aria-label="foner home"><img class="logo logo-light" src="icons/logo-light.png" alt="foner" width="93" height="24"><img class="logo logo-dark" src="icons/logo-dark.png" alt="foner" width="93" height="24"></a>
    ${switcher}
  </header>`;
}

function shell(active, inner, { bare = false } = {}) {
  const n = nav(active);
  return `<div class="shell">${topbar()}${n.rail}<main id="main">${bare ? inner : `<div class="page">${inner}</div>`}</main>${n.tabs}</div>`;
}

// ---------- views ----------
function callRow(c, current) {
  const isNew = c.status === "new" && c.kind !== "silent";
  const isUnread = !c.read_at && c.kind !== "silent";
  return `<a class="card call k-${c.kind} ${isNew ? "is-new" : "is-handled"} ${isUnread ? "is-unread" : ""}" href="#/calls/${c.id}" ${current ? 'aria-current="true"' : ""}>
    <span class="stripe" aria-hidden="true"></span>
    <span class="body">
      <span class="name" style="display:block">${isUnread ? '<span class="unread-dot" aria-hidden="true"></span>' : ""}${esc(displayName(c))}${isUnread ? '<span class="sr-only"> (unread)</span>' : ""}${isNew ? '<span class="sr-only"> (to do)</span>' : ""}</span>
      <span class="what" style="display:block">${esc(whatLine(c))}</span>
      ${c.address ? `<span class="where" style="display:block">${esc(shortAddress(c.address))}</span>` : ""}
    </span>
    <span class="side">
      <span class="when">${ago(c.started_at)}</span>
      <span class="chip k-${c.kind}">${KIND[c.kind] || "Call"}</span>
    </span>
  </a>`;
}

function ticket(c) {
  const num = numberOf(c);
  const wa = waLink(num);
  return `<article class="card ticket k-${c.kind}">
    <div class="top">
      <a class="open" href="#/calls/${c.id}"><div class="name">${esc(displayName(c))}</div>
      <div class="meta">${esc(whatLine(c))}${c.address ? `<br>${esc(shortAddress(c.address))}` : ""}</div></a>
      <div style="display:grid;justify-items:end;gap:6px"><span class="chip k-${c.kind}">${KIND[c.kind]}</span><span class="muted small">${ago(c.started_at)}</span></div>
    </div>
    ${c.notes ? `<p class="small" style="color:var(--ink-2)">${esc(c.notes)}</p>` : ""}
    <div class="acts">
      ${num ? `<a class="btn primary" href="tel:${digits(num)}">${I.phone}Call ${esc(firstName(c.caller_name) || prettyNumber(num))}</a>` : `<a class="btn" href="#/calls/${c.id}">Open call</a>`}
      ${wa ? `<a class="btn whatsapp icon" href="${wa}" target="_blank" rel="noopener" aria-label="WhatsApp ${esc(displayName(c))}">${I.wa}</a>` : ""}
      ${c.job_id && jobById(c.job_id) && jobById(c.job_id).quote_amount == null ? `<button class="btn icon price-ico" data-price="${c.job_id}" aria-label="Add price for ${esc(displayName(c))}">£</button>` : ""}
      <button class="btn icon" data-done="${c.id}" aria-label="Mark ${esc(displayName(c))} as done">${I.check}</button>
    </div>
  </article>`;
}

function viewHome() {
  const c = client();
  const list = todo();
  const n = list.length;
  const ms = monthStart();
  const month = state.calls.filter((x) => live(x) && new Date(x.started_at) >= ms);
  const answered = month.filter((x) => x.kind !== "silent");
  const enquiries = month.filter((x) => x.kind === "enquiry").length;
  const messages = month.filter((x) => x.kind === "message").length;
  const mins = Math.ceil(month.reduce((s, x) => s + (x.duration_secs || 0), 0) / 60);
  const plan = c?.plan_minutes || 60;
  const pct = Math.min(100, Math.round((mins / plan) * 100));
  const people = n === 1 ? "person" : "people";
  const head = n
    ? `<span class="n">${n}</span>${people} to get back to`
    : "You're all caught up";

  const tickets = n
    ? `<div class="list tickets">${list.slice(0, 6).map(ticket).join("")}</div>${n > 6 ? `<p style="margin-top:10px"><a href="#/calls">See all ${n} calls to do</a></p>` : ""}`
    : `<div class="card empty"><h3>Nothing waiting</h3><p>When ${esc(c?.details?.receptionist_name || "your receptionist")} takes a call, the caller shows up here with a button to ring them straight back.</p></div>`;

  // Money this month (jobs that started from a foner call)
  const mk = todayKey().slice(0, 7);
  const fj = state.jobs.filter((j) => j.from_foner);
  const wonM = fj.filter((j) => (j.won_at || "").startsWith(mk));
  const quotedM = fj.filter((j) => (j.quoted_at || "").startsWith(mk));
  const wonSum = wonM.reduce((s, j) => s + jobValue(j), 0);
  const quotedSum = quotedM.reduce((s, j) => s + Number(j.quote_amount || 0), 0);
  const value = `<a class="value-line money-link" href="#/money">
      <span><strong>${gbp(wonSum)}</strong> won and <strong>${gbp(quotedSum)}</strong> quoted from foner calls this month</span>${I.next}</a>`;

  // Today: bookings and quotes to chase
  const tk = todayKey();
  const todays = state.events.filter((e) => !e.done && eventDays(e).includes(tk) && e.kind !== "callback");
  const chase = state.events.filter((e) => !e.done && e.kind === "callback" && eventDays(e)[0] <= tk);
  const todayHtml = todays.length || chase.length ? `<section class="section" aria-labelledby="t-h" style="margin-top:0">
      <div class="section-head"><h2 id="t-h">Today</h2><a href="#/calendar">Calendar</a></div>
      <div class="list">${[...todays, ...chase].map((e) => eventCard(e, { showDay: e.kind === "callback" && eventDays(e)[0] < tk })).join("")}</div>
    </section>` : "";

  return shell("home", `
    <section class="band"><div class="band-inner">
      <p class="hello">${greeting()}${c?.owner_name ? `, ${esc(c.owner_name)}` : ""}</p>
      <h1 class="headline">${head}</h1>
    </div></section>
    <div class="page lift">
      ${tickets}
      <div style="margin-top:26px">${todayHtml}</div>
      <section class="section" aria-labelledby="m-h">
        <div class="section-head"><h2 id="m-h">This month</h2><a href="#/money">More</a></div>
        <div class="card month">
          <div class="row">
            <div><div class="num">${answered.length}</div><div class="lbl">calls answered</div></div>
            <div><div class="num">${enquiries}</div><div class="lbl">new enquiries</div></div>
            <div><div class="num">${messages}</div><div class="lbl">messages</div></div>
          </div>
          <div>
            <div class="small" style="display:flex;justify-content:space-between;margin-bottom:6px"><span>${mins} of ${plan} minutes used</span><span class="muted">${esc(c?.plan_name || "")} plan</span></div>
            <div class="meter ${mins > plan ? "over" : ""}" role="img" aria-label="${mins} of ${plan} minutes used"><span style="width:${pct}%"></span></div>
          </div>
          ${value}
        </div>
      </section>
    </div>`, { bare: true });
}

function filteredCalls() {
  const q = state.query.trim().toLowerCase();
  return state.calls.filter((c) => {
    if (state.filter === "hidden") { if (!c.hidden_reason) return false; }
    else if (c.hidden_reason) return false;
    if (state.filter === "todo" && !(c.status === "new" && c.kind !== "silent")) return false;
    if (state.filter === "unread" && (c.read_at || c.kind === "silent")) return false;
    if (state.filter === "enquiry" && c.kind !== "enquiry") return false;
    if (state.filter === "message" && c.kind !== "message") return false;
    if (state.filter === "no_details" && c.kind !== "no_details") return false;
    if (state.filter === "all" && c.kind === "silent") return false;
    if (!q) return true;
    return [c.caller_name, c.address, c.caller_number, c.caller_id_number, c.service, c.title, c.notes, c.caller_email]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });
}

function callsListHtml(currentId) {
  const nHidden = state.calls.filter((c) => c.hidden_reason).length;
  const f = [["todo", `To do (${todo().length})`], ["unread", `Unread (${unread().length})`], ["all", "All"], ["enquiry", "Enquiries"], ["message", "Messages"], ["no_details", "No details"]];
  if (nHidden || state.filter === "hidden") f.push(["hidden", `Spam and tests (${nHidden})`]);
  const list = filteredCalls();
  let lastDay = "", rows = "";
  for (const c of list) {
    const d = dayLabel(c.started_at);
    if (d !== lastDay) { rows += `<h3 class="day">${d}</h3>`; lastDay = d; }
    rows += callRow(c, c.id === currentId);
  }
  const empty = state.filter === "todo"
    ? `<div class="card empty"><h3>You're all caught up</h3><p>Every call has been dealt with. <button class="link" data-filter="all">Show all calls</button></p></div>`
    : `<div class="card empty"><h3>No calls match</h3><p>Try a different filter or search.</p></div>`;
  return `
    <h1 style="margin-bottom:14px">Calls</h1>
    <label class="sr-only" for="q">Search calls</label>
    <input id="q" class="search" type="search" placeholder="Search name, address, number or job" value="${esc(state.query)}" autocomplete="off">
    <div class="filters" role="group" aria-label="Show">${f.map(([k, l]) => `<button data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join("")}</div>
    <div class="list" id="call-list">${rows || empty}</div>`;
}

function viewCalls() {
  if (desktop.matches) {
    return shell("calls", `<div class="split"><div class="pane">${callsListHtml(null)}</div>
      <div class="pane"><div class="empty" style="margin-top:12vh"><h3>Pick a call</h3><p>Choose a call on the left to see the details, play it back and ring them.</p></div></div></div>`, { bare: true });
  }
  return shell("calls", callsListHtml(null));
}

async function viewCallDetail(id) {
  const { data: c, error } = await sb.from("calls").select("*").eq("id", id).maybeSingle();
  if (error || !c) {
    return shell("calls", `<a class="back" href="#/calls">${I.back}Calls</a><div class="card empty"><h3>Call not found</h3><p>It may belong to a different business, or the link is out of date.</p></div>`);
  }
  if (c.client_id !== state.clientId && state.clients.some((x) => x.id === c.client_id)) {
    state.clientId = c.client_id; store.set("foner.client", c.client_id);
    await loadCalls(true); subscribe();
  }
  const local = state.calls.find((x) => x.id === id);
  if (local) { c.status = local.status; c.read_at = local.read_at ?? c.read_at; }
  if (!c.read_at && c.kind !== "silent") {
    // Opening a call marks it read
    c.read_at = new Date().toISOString();
    if (local) local.read_at = c.read_at;
    sb.from("calls").update({ read_at: c.read_at }).eq("id", id).then(() => {});
  }
  await loadCRM();
  const { data: notes } = await sb.from("call_notes").select("*").eq("call_id", id).order("created_at");
  const biz = client();
  const num = numberOf(c);
  const wa = waLink(num);
  const isNew = c.status === "new";
  const facts = [
    ["Name", c.caller_name && esc(c.caller_name)],
    ["Number", num && `<a href="tel:${digits(num)}">${esc(prettyNumber(num))}</a>${num !== c.caller_number ? ' <span class="muted small">(caller ID)</span>' : ""}`],
    ["Address", c.address && `${esc(c.address)} <a class="small" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}" target="_blank" rel="noopener">Map</a>`],
    ["Email", c.caller_email && `<a href="mailto:${esc(c.caller_email)}">${esc(c.caller_email)}</a>`],
    ["Job", c.service && esc(cap(c.service))],
    ["Quote by", c.quote_method && esc(c.quote_method)],
    ["Visit days", c.visit_preference && esc(c.visit_preference)],
    ["Notes", c.notes && esc(c.notes)],
  ].filter(([, v]) => v);

  const transcript = (c.transcript || []).map((m) => {
    const t = `${Math.floor(m.t / 60)}:${String(m.t % 60).padStart(2, "0")}`;
    const who = m.role === "caller" ? "Caller" : esc(biz?.details?.receptionist_name || "Receptionist");
    return `<div class="bubble ${m.role}"><span class="t">${who}, ${t}</span>${esc(m.text.replace(/^\[[a-z ]+\]\s*/i, ""))}</div>`;
  }).join("");

  const detail = `
    <div class="back-row"><a class="back" href="#/calls">${I.back}Calls</a>
      ${c.kind !== "silent" ? `<button class="btn ghost small" data-unread="${c.id}">Mark as unread</button>` : ""}</div>
    ${c.hidden_reason ? `<div class="err-box" style="margin-bottom:12px">Hidden as ${c.hidden_reason === "spam" ? "spam" : "a test call"}. It doesn't appear in your lists or figures.</div>` : ""}
    <div class="detail-head">
      <div><span class="chip k-${c.kind}">${KIND[c.kind] || "Call"}</span></div>
      <h1>${esc(displayName(c))}</h1>
      ${c.title ? `<p class="title">${esc(c.title)}</p>` : ""}
      <p class="when">${longFmt.format(new Date(c.started_at))}, ${dur(c.duration_secs)}${c.ended_reason ? `. ${esc(c.ended_reason)}.` : ""}</p>
    </div>
    <div class="actions">
      ${num ? `<a class="btn primary" href="tel:${digits(num)}">${I.phone}Call ${esc(prettyNumber(num))}</a>` : ""}
      ${wa ? `<a class="btn whatsapp" href="${wa}" target="_blank" rel="noopener">${I.wa}WhatsApp</a>` : ""}
      ${c.caller_email ? `<a class="btn" href="mailto:${esc(c.caller_email)}">${I.mail}Email</a>` : ""}
      ${num ? `<button class="btn" data-copy="${esc(num)}">${I.copy}Copy number</button>` : ""}
    </div>
    ${jobPanelForCall(c)}
    ${facts.length ? `<section class="section"><div class="section-head"><h2>Details</h2></div><dl class="card facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></section>` : ""}
    ${c.summary ? `<section class="section"><div class="section-head"><h2>What happened</h2></div><div class="card summary">${esc(c.summary)}</div></section>` : ""}
    <section class="section">
      <div class="section-head"><h2>Recording</h2></div>
      <div class="card panel-pad" id="audio-box"><button class="btn" data-audio="${c.id}">${I.play}Play recording</button></div>
    </section>
    ${transcript ? `<section class="section"><details class="card fold"><summary>Full transcript ${I.chev}</summary>
      <div class="transcript">${transcript}${c.ended_reason ? `<p class="ended">${esc(c.ended_reason)}</p>` : ""}</div></details></section>` : ""}
    <section class="section" aria-labelledby="n-h">
      <div class="section-head"><h2 id="n-h">Your notes</h2></div>
      <div class="card notes">
        ${(notes || []).map((n) => `<div class="note"><p>${esc(n.body)}</p><p class="by">${esc(n.author_email)}, ${ago(n.created_at)}</p></div>`).join("") || '<p class="muted small">Jot down what happened next, for example "Quoted £650, chasing Friday".</p>'}
        <form class="stack" data-note="${c.id}">
          <label class="sr-only" for="note-body">Add a note</label>
          <textarea id="note-body" name="body" placeholder="Add a note" required maxlength="4000" style="min-height:72px"></textarea>
          <div><button class="btn small" type="submit">Save note</button></div>
        </form>
      </div>
    </section>
    <p style="margin-top:22px" class="small">Did the receptionist handle this call wrong? <button class="link" data-suggest-call="${c.id}">Suggest a change</button></p>
    <section class="section tidy">
      ${c.hidden_reason
        ? `<p class="small">This call is hidden as ${c.hidden_reason === "spam" ? "spam" : "a test call"}. <button class="link" data-hide="" data-call="${c.id}">Restore it</button></p>`
        : `<p class="small muted">Not a real enquiry? <button class="link" data-hide="spam" data-call="${c.id}">Mark as spam</button> or <button class="link" data-hide="test" data-call="${c.id}">mark as a test call</button>. It's hidden from your lists and figures, and you can restore it.</p>`}
      ${state.isAdmin ? `<p class="small"><button class="link danger" data-del-call="${c.id}">Delete this call permanently</button> <span class="muted">(admin only)</span></p>` : ""}
    </section>
    <div class="donebar">
      ${isNew
        ? `<button class="btn primary" data-done="${c.id}">${I.check}Mark as done</button>`
        : `<button class="btn done" data-undone="${c.id}">${I.check}Done${c.handled_at ? `, ${ago(c.handled_at).toLowerCase()}` : ""}. Move back to to-do</button>`}
    </div>`;

  if (desktop.matches) {
    return shell("calls", `<div class="split"><div class="pane">${callsListHtml(id)}</div><div class="pane">${detail}</div></div>`, { bare: true });
  }
  return shell("calls", detail);
}

function viewAgent() {
  const c = client();
  const d = c?.details || {};
  const rn = d.receptionist_name || "Your receptionist";
  const settings = [
    ["services", "Services it talks about", d.services],
    ["areas", "Areas you cover", d.areas],
    ["flags", "Calls it flags to you", d.flags],
    ["never_says", "Things it never does", d.never_says],
    ["hours", "When it answers", d.hours],
    ["notifications", "Call summaries are emailed to", c?.notification_email],
  ];
  const reqs = state.requests.map((r) => `<div class="req">
      <div class="row"><strong>${r.kind === "agent_behaviour" ? "How calls are handled" : esc(sectionLabel(r.section))}</strong><span class="chip st-${r.status}">${STATUS[r.status]}</span></div>
      <p class="msg">${esc(r.message)}</p>
      ${r.admin_reply ? `<p class="reply">${esc(r.admin_reply)}</p>` : ""}
      <p class="muted small">${ago(r.created_at)}${r.call_id ? ` from <a href="#/calls/${r.call_id}">a call</a>` : ""}</p>
    </div>`).join("");

  return shell("agent", `
    <h1 style="margin-bottom:14px">Receptionist</h1>
    <div class="card agent-hero">
      <p class="muted small">${esc(rn)} answers on</p>
      <p class="num">${esc(c?.ai_number || "Number being set up")}</p>
      <p class="small" style="color:var(--ink-2)">Divert the calls you miss to this number and ${esc(rn)} picks them up. It takes the caller's details and never gives prices or confirms bookings.</p>
    </div>
    <section class="section" aria-labelledby="s-h">
      <div class="section-head"><h2 id="s-h">What it knows</h2></div>
      <div class="card">${settings.map(([k, label, v]) => `<div class="setting">
        <div class="row"><span class="k">${label}</span><button class="btn ghost small" data-change="${k}">Change</button></div>
        <p class="v">${v ? esc(v) : '<span class="muted">Not set</span>'}</p></div>`).join("")}</div>
      <p class="muted small" style="margin-top:8px">Changes are checked by foner before they go live, so nothing reaches your callers by accident. You'll see progress below.</p>
    </section>
    <section class="section" aria-labelledby="b-h">
      <div class="section-head"><h2 id="b-h">Tell us how calls should go</h2></div>
      <form class="card panel-pad stack" id="behaviour-form">
        <label class="field" for="beh">What should ${esc(rn)} do differently?
          <span class="hint">Write it the way you'd tell a new member of staff.</span></label>
        <textarea id="beh" name="message" required maxlength="4000" placeholder="For example: if someone mentions a leak, tell them I'll call back the same day."></textarea>
        <div class="examples" aria-label="Ideas">
          <button type="button" data-example="Ask every caller how they heard about us.">Ask how they found us</button>
          <button type="button" data-example="Don't ask for an email address, just a phone number.">Skip the email question</button>
          <button type="button" data-example="Keep the greeting shorter.">Shorter greeting</button>
          <button type="button" data-example="Tell callers we're fully booked until next month.">We're booked up</button>
        </div>
        <div><button class="btn primary" type="submit">Send suggestion</button></div>
      </form>
    </section>
    <section class="section" aria-labelledby="h-h">
      <div class="section-head"><h2 id="h-h">Your requests</h2></div>
      <div class="card">${reqs || '<div class="empty"><p>Nothing sent yet. Anything you ask for shows here with its progress.</p></div>'}</div>
    </section>`);
}
function sectionLabel(k) {
  return ({ services: "Services", areas: "Areas covered", flags: "Calls it flags", never_says: "Things it never does", hours: "When it answers", notifications: "Where summaries go" })[k] || "Business details";
}

function viewAccount() {
  const c = client();
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return shell("account", `
    <h1 style="margin-bottom:14px">Account</h1>
    <div class="card">
      <div class="setting"><span class="k">Signed in as</span><p class="v">${esc(state.email)}</p></div>
      <div class="setting"><span class="k">Business</span><p class="v">${esc(c?.business_name || "")}</p></div>
      <div class="setting"><span class="k">Plan</span><p class="v">${esc(c?.plan_name || "")}, ${c?.plan_minutes || 60} call minutes a month</p></div>
    </div>
    <section class="section">
      <div class="section-head"><h2>Put foner on your home screen</h2></div>
      <div class="card panel-pad"><p>${ios
        ? "In Safari, tap the Share button, then <strong>Add to Home Screen</strong>. foner then opens like an app."
        : "In Chrome, open the menu (three dots), then <strong>Add to Home screen</strong> or <strong>Install app</strong>. foner then opens like an app."}</p></div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Change password</h2></div>
      <form class="card panel-pad stack" id="pw-form">
        <label class="field" for="pw1">New password <span class="hint">At least 8 characters.</span></label>
        <input id="pw1" class="input" type="password" name="pw" minlength="8" autocomplete="new-password" required>
        <div><button class="btn" type="submit">Update password</button></div>
      </form>
    </section>
    <section class="section">
      <div class="section-head"><h2>Help</h2></div>
      <div class="card panel-pad stack">
        <p>Questions about your receptionist or your account? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and Jake will get back to you.</p>
        <div><button class="btn" id="signout">Sign out</button></div>
      </div>
    </section>`);
}

async function viewAdmin() {
  if (!state.isAdmin) { location.hash = "#/"; return ""; }
  const { data: reqs } = await sb.from("change_requests").select("*, clients(business_name)").order("created_at", { ascending: false }).limit(100);
  const open = (reqs || []).filter((r) => r.status === "pending" || r.status === "in_progress");
  const closed = (reqs || []).filter((r) => !(r.status === "pending" || r.status === "in_progress")).slice(0, 20);
  const card = (r) => `<form class="req" data-req="${r.id}">
      <div class="row"><strong>${esc(r.clients?.business_name || "")}</strong><span class="chip st-${r.status}">${STATUS[r.status]}</span></div>
      <p class="small muted">${r.kind === "agent_behaviour" ? "How calls are handled" : esc(sectionLabel(r.section))}, from ${esc(r.created_by_email)}, ${ago(r.created_at)}${r.call_id ? `, <a href="#/calls/${r.call_id}">see call</a>` : ""}</p>
      <p class="msg">${esc(r.message)}</p>
      <label class="sr-only" for="rep-${r.id}">Reply to customer</label>
      <textarea id="rep-${r.id}" name="reply" placeholder="Reply the customer will see (optional)" style="min-height:64px">${esc(r.admin_reply || "")}</textarea>
      <div class="row" style="justify-content:flex-start;flex-wrap:wrap">
        <select name="status" class="input" style="width:auto;min-height:38px;padding:4px 10px">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${l}</option>`).join("")}</select>
        <button class="btn small primary" type="submit">Save</button>
      </div>
    </form>`;
  return shell("admin", `
    <h1 style="margin-bottom:14px">Admin</h1>
    <section class="section" style="margin-top:0">
      <div class="section-head"><h2>Open requests (${open.length})</h2></div>
      <div class="card">${open.map(card).join("") || '<div class="empty"><p>No open requests.</p></div>'}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Import past calls</h2></div>
      <div class="card panel-pad stack">
        <p class="small">Pulls the last 30 days of phone calls from ElevenLabs for the business selected at the top. Calls already in the portal are skipped.</p>
        <div><button class="btn" id="import">Import for ${esc(client()?.business_name || "")}</button></div>
        <p class="small muted" id="import-out"></p>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Recently closed</h2></div>
      <div class="card">${closed.map(card).join("") || '<div class="empty"><p>Nothing yet.</p></div>'}</div>
    </section>`);
}

function viewLogin(msg = "") {
  return `<div class="login"><div class="login-inner">
    <img src="icons/logo-dark.png" alt="foner" width="155" height="40">
    <div><h1>Your calls, in one place</h1><p style="margin-top:8px">Sign in to see who called, ring them back and adjust your receptionist.</p></div>
    <form id="login-form" novalidate>
      <label>Email<input class="input" type="email" name="email" autocomplete="email" inputmode="email" required></label>
      <label>Password<input class="input" type="password" name="password" autocomplete="current-password" required></label>
      ${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ""}
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <p class="small">Forgotten your password, or don't have one yet? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
  </div></div>`;
}

function viewSetPassword() {
  return `<div class="login"><div class="login-inner">
    <img src="icons/logo-dark.png" alt="foner" width="155" height="40">
    <div><h1>Choose a password</h1><p style="margin-top:8px">You'll use this with your email to sign in.</p></div>
    <form id="setpw-form">
      <label>New password<input class="input" type="password" name="pw" minlength="8" autocomplete="new-password" required></label>
      <button class="btn primary" type="submit">Save password</button>
    </form>
  </div></div>`;
}

function viewNoBusiness() {
  return `<div class="login"><div class="login-inner">
    <img src="icons/logo-dark.png" alt="foner" width="155" height="40">
    <div><h1>Almost there</h1><p style="margin-top:8px">You're signed in as ${esc(state.email)}, but this email isn't linked to a business yet. Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> and we'll connect it.</p></div>
    <button class="btn" id="signout">Sign out</button>
  </div></div>`;
}

// ---------- sheet ----------
function openSheet({ title, intro = "", body, submit, onSubmit }) {
  const wrap = document.createElement("div");
  wrap.className = "scrim";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-t">
    <div class="grab" aria-hidden="true"></div>
    <h2 id="sheet-t">${title}</h2>
    ${intro ? `<p class="muted small" style="margin-top:6px">${intro}</p>` : ""}
    <form class="stack" style="margin-top:14px">${body}
      <div class="foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${submit}</button></div>
    </form></div>`;
  const prevFocus = document.activeElement;
  const close = () => { wrap.remove(); prevFocus?.focus?.(); };
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) close(); });
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  wrap.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || wrap.querySelector('[type="submit"]');
    btn.disabled = true;
    const ok = await onSubmit(new FormData(e.target));
    btn.disabled = false;
    if (ok !== false) close();
  });
  document.body.appendChild(wrap);
  wrap.querySelector("textarea, input")?.focus();
}

async function sendRequest({ kind, section = null, message, call_id = null }) {
  const { data, error } = await sb.from("change_requests")
    .insert({ client_id: state.clientId, kind, section, message, call_id })
    .select().single();
  if (error) { toast("Couldn't send that. Check your connection and try again."); return false; }
  state.requests.unshift(data);
  toast("Sent to foner. Progress shows under Your requests on the Receptionist page.");
  return true;
}

// =====================================================================
// CRM: jobs, customers, calendar, money
// =====================================================================
const fld = (label, control, hint = "") =>
  `<label class="field">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}${control}</label>`;
const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(l)}</option>`;
const normPhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("44") && d.length === 12) d = "0" + d.slice(2);
  return d;
};
function swapList(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
const stageChip = (s) => `<span class="chip st-${s}">${STAGES[s]}</span>`;
const mapLink = (a) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;

function nextSteps(job, compact = false) {
  const b = (step, label, primary) =>
    `<button class="btn ${primary ? "primary" : ""} ${compact ? "small" : ""}" data-step="${step}" data-job="${job.id}">${label}</button>`;
  switch (job.stage) {
    case "new": return b("visit", "Book quote visit", false);
    case "visit_booked": return "";
    case "quoted": return b("won", "Won at a different price", false);
    case "won": return b("book", "Book the job", true);
    case "booked": return b("complete", "Mark completed", true);
    default: return "";
  }
}

function jobLine(j) {
  const ev = nextEventFor(j.id);
  if (ev) return `${EVENT_KIND[ev.kind]} ${prettyDay(eventDays(ev)[0])}${ev.all_day ? "" : ` ${eventTime(ev)}`}`;
  if (j.stage === "quoted" && j.quoted_at) return `Quoted ${prettyDay(j.quoted_at).toLowerCase()}`;
  if (j.stage === "completed" && j.completed_at) return `Completed ${prettyDay(j.completed_at).toLowerCase()}`;
  if (j.stage === "lost") return j.lost_reason || "Lost";
  return `Added ${ago(j.created_at).toLowerCase()}`;
}

function jobCard(j) {
  const cu = customerById(j.customer_id);
  const val = j.won_amount ?? j.quote_amount;
  return `<a class="card jobcard" href="#/jobs/${j.id}">
    <span class="jc-main">
      <span class="name">${esc(custName(cu))}</span>
      <span class="what">${esc(cap(j.service) || "Job")}${j.address || cu?.address ? `, ${esc(shortAddress(j.address || cu?.address))}` : ""}</span>
      <span class="sub">${esc(jobLine(j))}${j.from_foner ? '<span class="via">via foner</span>' : ""}</span>
    </span>
    <span class="jc-side">${stageChip(j.stage)}${val != null ? `<span class="amt">${gbp(val)}</span>` : ""}</span>
  </a>`;
}

function eventCard(e, { showDay = false } = {}) {
  const cu = customerById(e.customer_id);
  const job = jobById(e.job_id);
  const phone = cu?.phone;
  const who = cu ? custName(cu) : e.title || EVENT_KIND[e.kind];
  const sub = [e.title && cu ? e.title : job?.service ? cap(job.service) : "", e.address || ""].filter(Boolean).join(", ");
  return `<article class="card evcard ev-${e.kind} ${e.done ? "is-done" : ""}">
    <div class="ev-time"><span>${showDay ? prettyDay(eventDays(e)[0]) : eventTime(e)}</span></div>
    <div class="ev-body">
      <button class="ev-open" data-ev-edit="${e.id}">
        <span class="chip ek-${e.kind}">${EVENT_KIND[e.kind]}</span>
        <span class="name">${esc(who)}</span>
        ${sub ? `<span class="what">${esc(sub)}</span>` : ""}
      </button>
      <div class="ev-acts">
        ${phone ? `<a class="btn small" href="tel:${digits(phone)}">${I.phone}Call</a>` : ""}
        ${e.address ? `<a class="btn small" href="${mapLink(e.address)}" target="_blank" rel="noopener">${I.map}Directions</a>` : ""}
        ${job ? `<a class="btn small ghost" href="#/jobs/${job.id}">Job</a>` : ""}
        <button class="btn small ${e.done ? "done" : ""}" data-ev-done="${e.id}" aria-pressed="${e.done}">${I.check}${e.done ? "Done" : "Mark done"}</button>
      </div>
    </div>
  </article>`;
}

function jobPanelForCall(c) {
  if (c.kind === "silent") return "";
  const job = jobById(c.job_id);
  const cu = customerById(c.customer_id);
  if (job) {
    const val = job.won_amount ?? job.quote_amount;
    return `<section class="section"><div class="card panel-pad jobpanel">
      <div class="row"><div><p class="muted small">Job</p><p class="jp-title"><a href="#/jobs/${job.id}">${esc(cap(job.service) || "Job")}</a></p></div>
        <div style="text-align:right">${stageChip(job.stage)}${val != null ? `<p class="amt">${gbp(val)}</p>` : ""}</div></div>
      ${priceStrip(job)}
      <p class="small" style="color:var(--ink-2)">${esc(jobLine(job))}</p>
      <div class="jp-acts">${nextSteps(job, true)}<a class="btn small ghost" href="#/jobs/${job.id}">Open job</a></div>
    </div></section>`;
  }
  if (cu) {
    return `<section class="section"><div class="card panel-pad jobpanel">
      <p class="small" style="color:var(--ink-2)">${esc(custName(cu))} is already a customer${state.jobs.some((j) => j.customer_id === cu.id) ? " with earlier jobs" : ""}.</p>
      <div class="jp-acts"><button class="btn small primary" data-newjob-cust="${cu.id}" data-from-call="${c.id}">${I.plus}Start a job</button><a class="btn small ghost" href="#/customers/${cu.id}">Open customer</a></div>
    </div></section>`;
  }
  return `<section class="section"><div class="card panel-pad jobpanel">
    <p class="small" style="color:var(--ink-2)">Not linked to a customer yet.</p>
    <div class="jp-acts"><button class="btn small primary" data-new-job="1" data-from-call="${c.id}">${I.plus}Add as customer and job</button></div>
  </div></section>`;
}

// ---------- Jobs ----------
const JOB_FILTERS = [
  ["active", "Active", (j) => OPEN_STAGES.includes(j.stage)],
  ["new", "New", (j) => j.stage === "new"],
  ["visit_booked", "Visit booked", (j) => j.stage === "visit_booked"],
  ["quoted", "Quoted", (j) => j.stage === "quoted"],
  ["won", "Won and booked", (j) => j.stage === "won" || j.stage === "booked"],
  ["completed", "Completed", (j) => j.stage === "completed"],
  ["lost", "Lost", (j) => j.stage === "lost"],
  ["all", "All", () => true],
];
function jobsListInner() {
  const test = (JOB_FILTERS.find((f) => f[0] === state.jobFilter) || JOB_FILTERS[0])[2];
  const q = state.jobQuery.trim().toLowerCase();
  const list = state.jobs.filter(test).filter((j) => {
    if (!q) return true;
    const cu = customerById(j.customer_id);
    return [cu?.name, cu?.phone, j.address, cu?.address, j.service, j.notes].some((v) => String(v || "").toLowerCase().includes(q));
  });
  if (!list.length) {
    return state.jobs.length
      ? `<div class="card empty"><h3>No jobs here</h3><p>Try another filter or search.</p></div>`
      : `<div class="card empty"><h3>No jobs yet</h3><p>Every enquiry call becomes a job automatically. You can also add leads from WhatsApp, Facebook or your website.</p><p style="margin-top:12px"><button class="btn primary" data-new-job="1">${I.plus}Add a job</button></p></div>`;
  }
  return list.map(jobCard).join("");
}
function viewJobs() {
  const counts = Object.fromEntries(JOB_FILTERS.map(([k, , t]) => [k, state.jobs.filter(t).length]));
  const quotedOpen = state.jobs.filter((j) => j.stage === "quoted").reduce((s, j) => s + Number(j.quote_amount || 0), 0);
  return shell("jobs", `
    <div class="page-head"><h1>Jobs</h1><button class="btn primary small" data-new-job="1">${I.plus}Add</button></div>
    ${quotedOpen ? `<p class="lede">${gbp(quotedOpen)} of quotes waiting for an answer.</p>` : ""}
    <label class="sr-only" for="jq">Search jobs</label>
    <input id="jq" class="search" type="search" placeholder="Search name, address or job" value="${esc(state.jobQuery)}" autocomplete="off">
    <div class="filters" role="group" aria-label="Show">${JOB_FILTERS.map(([k, l]) => `<button data-jfilter="${k}" aria-pressed="${state.jobFilter === k}">${l}${k !== "all" ? ` (${counts[k]})` : ""}</button>`).join("")}</div>
    <div class="list" id="job-list">${jobsListInner()}</div>`);
}

async function viewJob(id) {
  let job = jobById(id);
  if (!job) {
    const { data } = await sb.from("jobs").select("*").eq("id", id).maybeSingle();
    if (data && data.client_id !== state.clientId && state.clients.some((x) => x.id === data.client_id)) {
      state.clientId = data.client_id; store.set("foner.client", data.client_id);
      state.callsFor = null; await Promise.all([loadCalls(true), loadCRM(true)]); subscribe();
    }
    job = jobById(id);
  }
  if (!job) return shell("jobs", `<a class="back" href="#/jobs">${I.back}Jobs</a><div class="card empty"><h3>Job not found</h3><p>It may have been deleted.</p></div>`);
  const cu = customerById(job.customer_id);
  const phone = cu?.phone;
  const wa = waLink(phone);
  const addr = job.address || cu?.address;
  const evs = state.events.filter((e) => e.job_id === job.id).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const calls = state.calls.filter((c) => live(c) && c.job_id === job.id);
  const lost = job.stage === "lost";
  const curIdx = STAGE_ORDER.indexOf(job.stage);
  const steps = STAGE_ORDER.map((s, i) => {
    const cls = lost ? "" : i < curIdx ? "done" : i === curIdx ? "current" : "";
    return `<li class="${cls}"><span class="pip" aria-hidden="true"></span><span>${STAGES[s]}</span></li>`;
  }).join("");
  const facts = [
    ["Quote", job.quote_amount != null && gbp(job.quote_amount)],
    ["Quote sent", job.quoted_at && prettyDay(job.quoted_at, true)],
    ["Accepted at", job.won_amount != null && gbp(job.won_amount)],
    ["Won on", job.won_at && prettyDay(job.won_at, true)],
    ["Job date", job.job_date && prettyDay(job.job_date, true)],
    ["Completed", job.completed_at && prettyDay(job.completed_at, true)],
    ["Lost", job.lost_reason && esc(job.lost_reason)],
    ["Came from", cu && esc(SOURCES[cu.source] || cu.source)],
    ["Notes", job.notes && esc(job.notes)],
  ].filter(([, v]) => v);
  const steps_ = nextSteps(job);
  return shell("jobs", `
    <div class="back-row"><a class="back" href="#/jobs">${I.back}Jobs</a><button class="btn ghost small" data-edit-job="${job.id}">Edit</button></div>
    <div class="detail-head">
      <div>${stageChip(job.stage)}${job.from_foner ? ' <span class="via">via foner</span>' : ""}</div>
      <h1><a class="plain" href="#/customers/${cu?.id || ""}">${esc(custName(cu))}</a></h1>
      <p class="title">${esc(cap(job.service) || "Job")}</p>
      ${addr ? `<p class="when">${esc(addr)}</p>` : ""}
    </div>
    <div class="actions">
      ${phone ? `<a class="btn primary" href="tel:${digits(phone)}">${I.phone}Call ${esc(firstName(cu?.name) || prettyNumber(phone))}</a>` : ""}
      ${wa ? `<a class="btn whatsapp" href="${wa}" target="_blank" rel="noopener">${I.wa}WhatsApp</a>` : ""}
      ${addr ? `<a class="btn" href="${mapLink(addr)}" target="_blank" rel="noopener">${I.map}Directions</a>` : ""}
    </div>
    <section class="section"><div class="card panel-pad nextstep">
      <h2>Price</h2>${priceStrip(job)}
      ${steps_ ? `<div class="ns-acts" style="margin-top:10px">${steps_}</div>` : ""}
    </div></section>
    <section class="section"><ol class="stepper ${lost ? "is-lost" : ""}" aria-label="Progress">${steps}</ol>
      ${lost ? `<p class="lostline">Lost${job.lost_reason ? `: ${esc(job.lost_reason)}` : ""}</p>` : ""}</section>
    ${facts.length ? `<section class="section"><div class="section-head"><h2>Details</h2></div><dl class="card facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></section>` : ""}
    <section class="section">
      <div class="section-head"><h2>Bookings</h2><button class="btn ghost small" data-new-event="1" data-job="${job.id}">${I.plus}Add booking</button></div>
      <div class="list">${evs.map((e) => eventCard(e, { showDay: true })).join("") || '<div class="card empty"><p>No visits, jobs or call-backs booked yet.</p></div>'}</div>
    </section>
    ${calls.length ? `<section class="section"><div class="section-head"><h2>Calls</h2></div><div class="list">${calls.map((c) => callRow(c)).join("")}</div></section>` : ""}
    <section class="section">
      <div class="card panel-pad stack">
        <label class="field" for="stage-sel">Change stage <span class="hint">For corrections. The buttons above fill in dates for you.</span></label>
        <select id="stage-sel" class="input" data-job="${job.id}">${Object.entries(STAGES).map(([k, l]) => opt(k, l, k === job.stage)).join("")}</select>
      </div>
    </section>
    <p style="margin-top:20px" class="small"><button class="link danger" data-del-job="${job.id}">Delete this job</button></p>`);
}

// ---------- Customers ----------
function customersListInner() {
  const q = state.custQuery.trim().toLowerCase();
  const list = state.customers.filter((c) =>
    !q || [c.name, c.phone, c.email, c.address].some((v) => String(v || "").toLowerCase().includes(q)));
  if (!list.length) return `<div class="card empty"><h3>${state.customers.length ? "No customers match" : "No customers yet"}</h3><p>${state.customers.length ? "Try a different search." : "Callers are added automatically. You can add others yourself."}</p></div>`;
  return list.map((c) => {
    const jobs = state.jobs.filter((j) => j.customer_id === c.id);
    const won = jobs.filter((j) => ["won", "booked", "completed"].includes(j.stage)).reduce((s, j) => s + jobValue(j), 0);
    return `<a class="card jobcard" href="#/customers/${c.id}">
      <span class="jc-main"><span class="name">${esc(custName(c))}</span>
        ${c.address ? `<span class="what">${esc(shortAddress(c.address))}</span>` : ""}
        <span class="sub">${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}${c.phone ? `, ${esc(prettyNumber(c.phone))}` : ""}</span></span>
      <span class="jc-side"><span class="chip src">${esc(SOURCES[c.source] || c.source)}</span>${won ? `<span class="amt">${gbp(won)}</span>` : ""}</span>
    </a>`;
  }).join("");
}
function viewCustomers() {
  return shell("customers", `
    <div class="page-head"><h1>Customers</h1><button class="btn primary small" data-new-job="1" data-customer-only="1">${I.plus}Add</button></div>
    <label class="sr-only" for="cq">Search customers</label>
    <input id="cq" class="search" type="search" placeholder="Search name, number or address" value="${esc(state.custQuery)}" autocomplete="off">
    <div class="list" id="cust-list">${customersListInner()}</div>`);
}
async function viewCustomer(id) {
  const cu = customerById(id);
  if (!cu) return shell("customers", `<a class="back" href="#/customers">${I.back}Customers</a><div class="card empty"><h3>Customer not found</h3></div>`);
  const jobs = state.jobs.filter((j) => j.customer_id === id);
  const calls = state.calls.filter((c) => live(c) && c.customer_id === id);
  const wa = waLink(cu.phone);
  const facts = [
    ["Number", cu.phone && `<a href="tel:${digits(cu.phone)}">${esc(prettyNumber(cu.phone))}</a>`],
    ["Email", cu.email && `<a href="mailto:${esc(cu.email)}">${esc(cu.email)}</a>`],
    ["Address", cu.address && `${esc(cu.address)} <a class="small" href="${mapLink(cu.address)}" target="_blank" rel="noopener">Map</a>`],
    ["Came from", esc(SOURCES[cu.source] || cu.source)],
    ["Customer since", prettyDay(dayKey(new Date(cu.created_at)), true)],
    ["Notes", cu.notes && esc(cu.notes)],
  ].filter(([, v]) => v);
  return shell("customers", `
    <div class="back-row"><a class="back" href="#/customers">${I.back}Customers</a><button class="btn ghost small" data-edit-cust="${cu.id}">Edit</button></div>
    <div class="detail-head"><h1>${esc(custName(cu))}</h1></div>
    <div class="actions">
      ${cu.phone ? `<a class="btn primary" href="tel:${digits(cu.phone)}">${I.phone}Call</a>` : ""}
      ${wa ? `<a class="btn whatsapp" href="${wa}" target="_blank" rel="noopener">${I.wa}WhatsApp</a>` : ""}
      ${cu.email ? `<a class="btn" href="mailto:${esc(cu.email)}">${I.mail}Email</a>` : ""}
    </div>
    <section class="section"><dl class="card facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></section>
    ${(() => {
      const open = jobs.filter((j) => OPEN_STAGES.includes(j.stage) || j.stage === "won");
      if (!open.length) return `<section class="section"><div class="card panel-pad nextstep"><h2>Price</h2>
        <button class="btn primary price-add" data-price-cust="${cu.id}"><span class="pound-ico" aria-hidden="true">£</span>Add price</button></div></section>`;
      return open.map((j) => `<section class="section"><div class="card panel-pad nextstep">
        <h2>${esc(cap(j.service) || "Price")}</h2>${priceStrip(j)}</div></section>`).join("");
    })()}
    <section class="section">
      <div class="section-head"><h2>Jobs</h2><button class="btn ghost small" data-newjob-cust="${cu.id}">${I.plus}New job</button></div>
      <div class="list">${jobs.map(jobCard).join("") || '<div class="card empty"><p>No jobs yet.</p></div>'}</div>
    </section>
    ${calls.length ? `<section class="section"><div class="section-head"><h2>Calls</h2></div><div class="list">${calls.map((c) => callRow(c)).join("")}</div></section>` : ""}
    <p style="margin-top:20px" class="small"><button class="link danger" data-del-cust="${cu.id}">Delete this customer</button> <span class="muted">(also deletes their jobs and bookings)</span></p>`);
}

// ---------- Calendar ----------
function calendarFeed() {
  const tok = client()?.calendar_token;
  if (!tok) return null;
  const https = `${SUPABASE_URL}/functions/v1/calendar?token=${tok}`;
  return { https, webcal: https.replace(/^https:/, "webcal:") };
}
function viewCalendar() {
  const tk = todayKey();
  if (!state.calStart) state.calStart = mondayOf(tk);
  const feed = calendarFeed();
  const byDay = {};
  for (const e of state.events) for (const d of eventDays(e)) (byDay[d] ||= []).push(e);
  const sortDay = (a, b) => (a.all_day === b.all_day ? a.starts_at.localeCompare(b.starts_at) : a.all_day ? -1 : 1);

  const feedCard = feed ? `<section class="section"><div class="card panel-pad stack">
      <h2>See bookings in your phone's calendar</h2>
      <p class="small" style="color:var(--ink-2)">Subscribe once and every visit, job and call-back you add here appears in your iPhone or Google calendar, updating automatically. Make changes here in foner.</p>
      <div class="jp-acts"><a class="btn primary small" href="${feed.webcal}">${I.calendar}Add to iPhone Calendar</a><button class="btn small" data-copy-cal="${esc(feed.https)}">${I.copy}Copy link for Google</button></div>
      <p class="muted small">Keep this link private: anyone with it can see your bookings.</p>
    </div></section>` : "";

  if (desktop.matches) {
    // Month grid
    const first = `${state.calStart.slice(0, 7)}-01`;
    const gridStart = mondayOf(first);
    const monthName = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${first}T12:00:00Z`));
    let cells = "";
    for (let i = 0; i < 42; i++) {
      const k = addDays(gridStart, i);
      const evs = (byDay[k] || []).sort(sortDay);
      const out = k.slice(0, 7) !== first.slice(0, 7);
      cells += `<div class="mcell ${out ? "out" : ""} ${k === tk ? "today" : ""}">
        <button class="mday" data-new-event="1" data-day="${k}" aria-label="Add booking on ${prettyDay(k, true)}">${Number(k.slice(8))}</button>
        ${evs.slice(0, 3).map((e) => `<button class="mev ek-${e.kind} ${e.done ? "is-done" : ""}" data-ev-edit="${e.id}">${e.all_day ? "" : `<b>${eventTime(e)}</b> `}${esc(custName(customerById(e.customer_id)) !== "Unnamed customer" ? custName(customerById(e.customer_id)) : e.title || EVENT_KIND[e.kind])}</button>`).join("")}
        ${evs.length > 3 ? `<span class="more">+${evs.length - 3} more</span>` : ""}
      </div>`;
    }
    return shell("calendar", `
      <div class="page-head"><h1>${monthName}</h1>
        <div class="cal-nav"><button class="btn small" data-cal="-month" aria-label="Previous month">${I.back}</button><button class="btn small" data-cal="today">Today</button><button class="btn small" data-cal="+month" aria-label="Next month">${I.next}</button><button class="btn primary small" data-new-event="1">${I.plus}Add</button></div></div>
      <div class="legend"><span class="chip ek-quote_visit">Quote visit</span><span class="chip ek-job">Job</span><span class="chip ek-callback">Call back</span></div>
      <div class="mgrid">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="mhead">${d}</div>`).join("")}${cells}</div>
      ${feedCard}`);
  }

  // Phone: a week at a time
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.calStart, i));
  const monthName = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${days[3]}T12:00:00Z`));
  const strip = days.map((k) => {
    const n = (byDay[k] || []).filter((e) => !e.done).length;
    const d = new Date(`${k}T12:00:00Z`);
    return `<a class="wday ${k === tk ? "today" : ""}" href="#d-${k}" data-scroll="d-${k}">
      <span class="wd">${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "narrow" }).format(d)}</span>
      <span class="wn">${d.getUTCDate()}</span><span class="wdot ${n ? "on" : ""}" aria-hidden="true"></span></a>`;
  }).join("");
  const agenda = days.map((k) => {
    const evs = (byDay[k] || []).sort(sortDay);
    return `<div class="aday" id="d-${k}">
      <div class="aday-head"><h3>${prettyDay(k)}</h3><button class="btn ghost small" data-new-event="1" data-day="${k}" aria-label="Add booking on ${prettyDay(k, true)}">${I.plus}</button></div>
      ${evs.length ? `<div class="list">${evs.map((e) => eventCard(e)).join("")}</div>` : `<p class="free">Nothing booked</p>`}
    </div>`;
  }).join("");
  return shell("calendar", `
    <div class="page-head"><h1>${monthName}</h1><button class="btn primary small" data-new-event="1">${I.plus}Add</button></div>
    <div class="weekbar">
      <button class="btn icon small" data-cal="-7" aria-label="Previous week">${I.back}</button>
      <div class="wstrip">${strip}</div>
      <button class="btn icon small" data-cal="7" aria-label="Next week">${I.next}</button>
    </div>
    ${state.calStart !== mondayOf(tk) ? `<p style="margin:-4px 0 10px"><button class="link" data-cal="today">Back to this week</button></p>` : ""}
    <div class="agenda">${agenda}</div>
    ${feedCard}`);
}

// ---------- Money ----------
const PERIODS = [["month", "This month"], ["last", "Last month"], ["year", "This year"], ["all", "All time"]];
function periodRange(p) {
  const tk = todayKey();
  const m0 = `${tk.slice(0, 7)}-01`;
  if (p === "month") return [m0, addDays(tk, 1), 1];
  if (p === "last") {
    const d = new Date(`${m0}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
    return [d.toISOString().slice(0, 10), m0, 1];
  }
  if (p === "year") return [`${tk.slice(0, 4)}-01-01`, addDays(tk, 1), Number(tk.slice(5, 7))];
  const since = dayKey(new Date(client()?.created_at || Date.now()));
  const months = Math.max(1, (Number(tk.slice(0, 4)) - Number(since.slice(0, 4))) * 12 + Number(tk.slice(5, 7)) - Number(since.slice(5, 7)) + 1);
  return ["0000-01-01", "9999-12-31", months];
}
function viewMoney() {
  const c = client();
  const [from, to, months] = periodRange(state.moneyPeriod);
  const inP = (k) => k && k >= from && k < to;
  const fj = state.jobs.filter((j) => j.from_foner);
  const calls = state.calls.filter((x) => live(x) && x.kind !== "silent" && inP(dayKey(new Date(x.started_at))));
  const enquiries = fj.filter((j) => inP(dayKey(new Date(j.created_at))));
  const quoted = fj.filter((j) => inP(j.quoted_at));
  const won = fj.filter((j) => inP(j.won_at));
  const lost = fj.filter((j) => j.stage === "lost" && inP(j.lost_at) && j.quote_amount != null);
  const wonSum = won.reduce((s, j) => s + jobValue(j), 0);
  const quotedSum = quoted.reduce((s, j) => s + Number(j.quote_amount || 0), 0);
  const decided = won.length + lost.length;
  const winRate = decided ? Math.round((won.length / decided) * 100) : null;
  const avg = won.length ? wonSum / won.length : null;
  const waiting = state.jobs.filter((j) => j.stage === "quoted");
  const waitingSum = waiting.reduce((s, j) => s + Number(j.quote_amount || 0), 0);
  const price = Number(c?.monthly_price || 0);
  const cost = price * months;
  const roi = cost > 0 && wonSum > 0
    ? `That's ${Math.round(wonSum / cost)}× what foner cost you (${gbp(cost)}).`
    : price === 0 && wonSum > 0 ? `You're on a free trial. At £49 a month, that would be ${Math.round(wonSum / (49 * months))}× the cost.` : "";
  const label = PERIODS.find((p) => p[0] === state.moneyPeriod)[1].toLowerCase();
  const max = Math.max(calls.length, 1);
  const bar = (n, l) => `<div class="fun"><div class="fun-row"><span>${l}</span><strong>${n}</strong></div><div class="meter"><span style="width:${Math.round((n / max) * 100)}%"></span></div></div>`;

  // All leads by source (jobs created in the period)
  const all = state.jobs.filter((j) => inP(dayKey(new Date(j.created_at))));
  const bySrc = {};
  for (const j of all) {
    const s = j.from_foner ? "foner_call" : customerById(j.customer_id)?.source || "other";
    const r = (bySrc[s] ||= { n: 0, won: 0 });
    r.n++; if (["won", "booked", "completed"].includes(j.stage)) r.won += jobValue(j);
  }

  return shell("money", `
    <section class="band"><div class="band-inner">
      <p class="hello">What foner made you, ${esc(label)}</p>
      <h1 class="headline"><span class="n">${gbp(wonSum)}</span>won from calls foner answered</h1>
      ${roi ? `<p class="roi">${roi}</p>` : ""}
    </div></section>
    <div class="page lift">
      <div class="card panel-pad">
        <div class="filters" role="group" aria-label="Period" style="padding-bottom:12px">${PERIODS.map(([k, l]) => `<button data-period="${k}" aria-pressed="${state.moneyPeriod === k}">${l}</button>`).join("")}</div>
        <div class="figs">
          <div><div class="num">${gbp(quotedSum)}</div><div class="lbl">quoted</div></div>
          <div><div class="num">${gbp(wonSum)}</div><div class="lbl">won</div></div>
          <div><div class="num">${winRate == null ? "–" : winRate + "%"}</div><div class="lbl">of decided quotes won</div></div>
          <div><div class="num">${avg == null ? "–" : gbp(avg)}</div><div class="lbl">average job won</div></div>
        </div>
      </div>
      <section class="section"><div class="section-head"><h2>From call to cash</h2></div>
        <div class="card panel-pad funnel">
          ${bar(calls.length, "Calls answered")}${bar(enquiries.length, "Enquiries")}${bar(quoted.length, "Quoted")}${bar(won.length, "Won")}
        </div>
        ${waiting.length ? `<p class="lede" style="margin-top:10px">${gbp(waitingSum)} in ${waiting.length} ${waiting.length === 1 ? "quote is" : "quotes are"} still waiting for an answer. <a href="#/jobs" data-jfilter-go="quoted">Chase them</a></p>` : ""}
      </section>
      <section class="section"><div class="section-head"><h2>Where your work comes from</h2></div>
        <div class="card">${Object.keys(bySrc).length ? Object.entries(bySrc).sort((a, b) => b[1].won - a[1].won || b[1].n - a[1].n).map(([s, r]) => `<div class="setting"><div class="row"><span>${esc(SOURCES[s] || s)}</span><span><strong>${gbp(r.won)}</strong> <span class="muted small">from ${r.n} ${r.n === 1 ? "lead" : "leads"}</span></span></div></div>`).join("") : '<div class="empty"><p>No leads in this period yet.</p></div>'}</div>
        <p class="muted small" style="margin-top:8px">Only jobs that started with a call foner answered count towards the figure at the top.</p>
      </section>
    </div>`, { bare: true });
}

function viewMore() {
  const links = [
    ["#/money", I.money, "What foner made you", "Quoted, won and your return on foner"],
    ["#/customers", I.account, "Customers", "Everyone who's called or you've added"],
    ["#/agent", I.agent, "Receptionist", "What it tells callers, and change requests"],
    ["#/account", I.gear, "Account", "Plan, password and help"],
  ];
  if (state.isAdmin) links.push(["#/admin", I.admin, "Admin", "Requests from every business"]);
  return shell("more", `<h1 style="margin-bottom:14px">More</h1><div class="card">${links.map(([h, i, t, s]) =>
    `<a class="morelink" href="${h}">${i}<span><strong>${t}</strong><span class="muted small">${s}</span></span>${I.next}</a>`).join("")}</div>`);
}

// ---------- Sheets ----------
function closeSheets() { document.querySelectorAll(".scrim").forEach((s) => s.remove()); }

async function closeOpenEvents(jobId, kinds) {
  const open = state.events.filter((e) => e.job_id === jobId && !e.done && kinds.includes(e.kind));
  for (const e of open) await save("events", e.id, { done: true });
}

function stepSheet(step, job) {
  const cu = customerById(job.customer_id);
  const addr = job.address || cu?.address || null;
  const tk = todayKey();
  const after = async () => { await loadCRM(true); route(); return true; };
  if (step === "visit") {
    return openSheet({
      title: "Book quote visit", intro: `${esc(custName(cu))}${addr ? `, ${esc(addr)}` : ""}`,
      body: `<div class="two">${fld("Date", `<input class="input" type="date" name="d" required value="${addDays(tk, 1)}">`)}${fld("Time", `<input class="input" type="time" name="t" required value="17:00">`)}</div>
        ${fld("How long", `<select class="input" name="len">${opt(30, "30 minutes", true)}${opt(60, "1 hour")}${opt(90, "1½ hours")}</select>`)}`,
      submit: "Book visit",
      onSubmit: async (fd) => {
        const start = londonISO(fd.get("d"), fd.get("t"));
        const end = new Date(new Date(start).getTime() + Number(fd.get("len")) * 60000).toISOString();
        if (!(await create("events", { kind: "quote_visit", job_id: job.id, customer_id: cu?.id, starts_at: start, ends_at: end, address: addr, title: job.service }))) return false;
        await save("jobs", job.id, { stage: "visit_booked" });
        toast("Quote visit booked.");
        return after();
      },
    });
  }
  if (step === "quote") return priceSheet(job);
  if (step === "won") {
    return openSheet({
      title: "Mark as won", intro: `${esc(custName(cu))} said yes.`,
      body: `${fld("Accepted amount (£)", `<input class="input" type="number" name="amt" inputmode="decimal" min="0" step="1" required value="${job.won_amount ?? job.quote_amount ?? ""}">`, "Change it if you agreed a different price.")}
        ${fld("Won on", `<input class="input" type="date" name="d" required value="${tk}">`)}
        <div class="two">${fld("Job date", `<input class="input" type="date" name="jd">`, "Optional")}${fld("Days", `<input class="input" type="number" name="days" min="1" max="30" value="1">`)}</div>`,
      submit: "Mark as won",
      onSubmit: async (fd) => {
        const amt = Number(fd.get("amt")), jd = fd.get("jd");
        if (!(await save("jobs", job.id, { stage: jd ? "booked" : "won", won_amount: amt, won_at: fd.get("d"), job_date: jd || null }))) return false;
        await closeOpenEvents(job.id, ["callback"]);
        if (jd) await create("events", { kind: "job", job_id: job.id, customer_id: cu?.id, all_day: true, starts_at: noonISO(jd), ends_at: noonISO(addDays(jd, Math.max(1, Number(fd.get("days")) || 1))), address: addr, title: job.service });
        toast(`Won: ${gbp(amt)}.`);
        return after();
      },
    });
  }
  if (step === "book") {
    return openSheet({
      title: "Book the job", intro: esc(custName(cu)),
      body: `<div class="two">${fld("Start date", `<input class="input" type="date" name="jd" required value="${job.job_date || addDays(tk, 7)}">`)}${fld("Days", `<input class="input" type="number" name="days" min="1" max="30" value="1">`)}</div>`,
      submit: "Book job",
      onSubmit: async (fd) => {
        const jd = fd.get("jd");
        if (!(await save("jobs", job.id, { stage: "booked", job_date: jd, won_at: job.won_at || tk }))) return false;
        await create("events", { kind: "job", job_id: job.id, customer_id: cu?.id, all_day: true, starts_at: noonISO(jd), ends_at: noonISO(addDays(jd, Math.max(1, Number(fd.get("days")) || 1))), address: addr, title: job.service });
        toast("Job booked.");
        return after();
      },
    });
  }
  if (step === "complete") {
    return openSheet({
      title: "Mark completed", intro: esc(custName(cu)),
      body: fld("Completed on", `<input class="input" type="date" name="d" required value="${tk}">`),
      submit: "Mark completed",
      onSubmit: async (fd) => {
        if (!(await save("jobs", job.id, { stage: "completed", completed_at: fd.get("d"), won_at: job.won_at || fd.get("d") }))) return false;
        await closeOpenEvents(job.id, ["job", "callback", "quote_visit"]);
        toast("Job completed.");
        return after();
      },
    });
  }
  if (step === "lost") {
    return openSheet({
      title: "Mark as lost", intro: "Knowing why helps you price and follow up better.",
      body: `${fld("Reason", `<select class="input" name="r">${LOST_REASONS.map((r, i) => opt(r, r, i === 0)).join("")}</select>`)}
        ${fld("Note", `<input class="input" name="n" maxlength="200" placeholder="Optional">`)}`,
      submit: "Mark as lost",
      onSubmit: async (fd) => {
        const reason = [fd.get("r"), String(fd.get("n") || "").trim()].filter(Boolean).join(": ");
        if (!(await save("jobs", job.id, { stage: "lost", lost_reason: reason, lost_at: tk }))) return false;
        await closeOpenEvents(job.id, ["callback", "quote_visit"]);
        toast("Marked as lost.");
        return after();
      },
    });
  }
}

function addJobSheet({ customerId = null, callId = null, customerOnly = false } = {}) {
  const cu = customerById(customerId);
  const call = state.calls.find((c) => c.id === callId) || null;
  const srcSel = (cur) => `<select class="input" name="src">${Object.entries(SOURCES).map(([k, l]) => opt(k, l, k === cur)).join("")}</select>`;
  const contact = cu ? "" : `
    ${fld("Name", `<input class="input" name="name" autocomplete="off" value="${esc(call?.caller_name || "")}">`)}
    ${fld("Phone", `<input class="input" name="phone" type="tel" value="${esc(call ? numberOf(call) : "")}">`)}
    ${fld("Address", `<input class="input" name="address" value="${esc(call?.address || "")}">`)}
    ${fld("Email", `<input class="input" name="email" type="email" value="${esc(call?.caller_email || "")}">`, "Optional")}
    ${fld("Where they came from", srcSel(call ? "foner_call" : "phone"))}`;
  const jobFields = `
    ${fld("Job", `<input class="input" name="service" placeholder="e.g. Roof clean and treatment" value="${esc(call?.service || "")}">`)}
    ${cu ? fld("Address", `<input class="input" name="jaddress" value="${esc(cu.address || "")}">`) : ""}
    ${fld("Notes", `<textarea name="notes" style="min-height:64px">${esc(call?.notes || "")}</textarea>`, "Optional")}`;
  openSheet({
    title: cu ? `New job for ${esc(custName(cu))}` : customerOnly ? "Add customer" : "Add customer and job",
    body: contact + (customerOnly
      ? `<label class="check"><input type="checkbox" name="withjob" data-toggle="jobfields"> Start a job for them too</label><div id="jobfields" hidden>${jobFields}</div>`
      : jobFields),
    submit: cu ? "Add job" : "Save",
    onSubmit: async (fd) => {
      let customer = cu;
      if (!customer) {
        const name = String(fd.get("name") || "").trim(), phone = String(fd.get("phone") || "").trim();
        if (!name && !phone) { toast("Add a name or phone number."); return false; }
        const match = phone ? state.customers.find((x) => normPhone(x.phone) && normPhone(x.phone) === normPhone(phone)) : null;
        customer = match || await create("customers", {
          name: name || null, phone: phone || null, address: String(fd.get("address") || "").trim() || null,
          email: String(fd.get("email") || "").trim() || null, source: fd.get("src") || "other",
        });
        if (!customer) return false;
        if (match) toast(`${esc(custName(match))} is already a customer, so the job was added to them.`);
      }
      const wantJob = !customerOnly || fd.get("withjob");
      if (!wantJob) { closeSheets(); location.hash = `#/customers/${customer.id}`; return true; }
      const job = await create("jobs", {
        customer_id: customer.id, service: String(fd.get("service") || "").trim() || null,
        address: String(fd.get("jaddress") || fd.get("address") || "").trim() || customer.address || null,
        notes: String(fd.get("notes") || "").trim() || null, from_foner: !!call, first_call_id: call?.id || null,
      });
      if (!job) return false;
      if (call) {
        await sb.from("calls").update({ customer_id: customer.id, job_id: job.id }).eq("id", call.id);
        Object.assign(call, { customer_id: customer.id, job_id: job.id });
      }
      closeSheets();
      location.hash = `#/jobs/${job.id}`;
      return true;
    },
  });
}

function editJobSheet(job) {
  openSheet({
    title: "Edit job",
    body: `${fld("Job", `<input class="input" name="service" value="${esc(job.service || "")}">`)}
      ${fld("Address", `<input class="input" name="address" value="${esc(job.address || "")}">`)}
      <div class="two">${fld("Quote (£)", `<input class="input" type="number" min="0" step="1" name="qa" value="${job.quote_amount ?? ""}">`)}${fld("Sent on", `<input class="input" type="date" name="qd" value="${job.quoted_at || ""}">`)}</div>
      <div class="two">${fld("Accepted (£)", `<input class="input" type="number" min="0" step="1" name="wa" value="${job.won_amount ?? ""}">`)}${fld("Won on", `<input class="input" type="date" name="wd" value="${job.won_at || ""}">`)}</div>
      <div class="two">${fld("Job date", `<input class="input" type="date" name="jd" value="${job.job_date || ""}">`)}${fld("Completed", `<input class="input" type="date" name="cd" value="${job.completed_at || ""}">`)}</div>
      ${fld("Notes", `<textarea name="notes" style="min-height:72px">${esc(job.notes || "")}</textarea>`)}`,
    submit: "Save",
    onSubmit: async (fd) => {
      const num = (k) => (String(fd.get(k) || "").trim() === "" ? null : Number(fd.get(k)));
      const dt = (k) => fd.get(k) || null;
      const ok = await save("jobs", job.id, {
        service: String(fd.get("service") || "").trim() || null, address: String(fd.get("address") || "").trim() || null,
        quote_amount: num("qa"), quoted_at: dt("qd"), won_amount: num("wa"), won_at: dt("wd"),
        job_date: dt("jd"), completed_at: dt("cd"), notes: String(fd.get("notes") || "").trim() || null,
      });
      if (ok) { toast("Job saved."); route(); }
      return !!ok;
    },
  });
}

function editCustomerSheet(cu) {
  openSheet({
    title: "Edit customer",
    body: `${fld("Name", `<input class="input" name="name" value="${esc(cu.name || "")}">`)}
      ${fld("Phone", `<input class="input" type="tel" name="phone" value="${esc(cu.phone || "")}">`)}
      ${fld("Email", `<input class="input" type="email" name="email" value="${esc(cu.email || "")}">`)}
      ${fld("Address", `<input class="input" name="address" value="${esc(cu.address || "")}">`)}
      ${fld("Where they came from", `<select class="input" name="src">${Object.entries(SOURCES).map(([k, l]) => opt(k, l, k === cu.source)).join("")}</select>`)}
      ${fld("Notes", `<textarea name="notes" style="min-height:72px">${esc(cu.notes || "")}</textarea>`)}`,
    submit: "Save",
    onSubmit: async (fd) => {
      const v = (k) => String(fd.get(k) || "").trim() || null;
      const ok = await save("customers", cu.id, { name: v("name"), phone: v("phone"), email: v("email"), address: v("address"), source: fd.get("src"), notes: v("notes") });
      if (ok) { toast("Customer saved."); route(); }
      return !!ok;
    },
  });
}

function eventSheet(ev, { jobId = null, day = null } = {}) {
  const job = jobById(ev?.job_id || jobId);
  const cuId = ev?.customer_id || job?.customer_id || "";
  const startKey = ev ? eventDays(ev)[0] : day || todayKey();
  const startTime = ev && !ev.all_day ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ev.starts_at)) : "09:00";
  const lenMin = ev && !ev.all_day && ev.ends_at ? Math.round((new Date(ev.ends_at) - new Date(ev.starts_at)) / 60000) : 60;
  const days = ev?.all_day ? eventDays(ev).length : 1;
  const allDay = ev ? ev.all_day : false;
  const custOpts = `<option value="">No customer</option>` + [...state.customers].sort((a, b) => custName(a).localeCompare(custName(b)))
    .map((c) => opt(c.id, custName(c), c.id === cuId)).join("");
  openSheet({
    title: ev ? "Booking" : "Add booking",
    body: `${fld("Type", `<select class="input" name="kind">${Object.entries(EVENT_KIND).map(([k, l]) => opt(k, l, k === (ev?.kind || (job?.stage === "won" ? "job" : "quote_visit")))).join("")}</select>`)}
      ${fld("Customer", `<select class="input" name="cust">${custOpts}</select>`)}
      <div class="two">${fld("Date", `<input class="input" type="date" name="d" required value="${startKey}">`)}${fld("Time", `<input class="input" type="time" name="t" value="${startTime}" ${allDay ? "disabled" : ""}>`)}</div>
      <label class="check"><input type="checkbox" name="allday" data-allday ${allDay ? "checked" : ""}> All day</label>
      <div class="two">${fld("Length (minutes)", `<input class="input" type="number" min="15" step="15" name="len" value="${lenMin}">`)}${fld("Days", `<input class="input" type="number" min="1" max="30" name="days" value="${days}">`, "All-day only")}</div>
      ${fld("Title", `<input class="input" name="title" value="${esc(ev?.title || job?.service || "")}" placeholder="Optional">`)}
      ${fld("Address", `<input class="input" name="address" value="${esc(ev?.address || job?.address || customerById(cuId)?.address || "")}">`)}
      ${fld("Notes", `<textarea name="notes" style="min-height:64px">${esc(ev?.notes || "")}</textarea>`)}
      ${ev ? `<p class="small"><button type="button" class="link danger" data-ev-del="${ev.id}">Delete this booking</button></p>` : ""}`,
    submit: ev ? "Save" : "Add booking",
    onSubmit: async (fd) => {
      const ad = !!fd.get("allday");
      const d = fd.get("d");
      const cust = fd.get("cust") || null;
      let link = ev?.job_id || jobId || null;
      if (!link && cust) link = state.jobs.find((j) => j.customer_id === cust && OPEN_STAGES.includes(j.stage))?.id || null;
      const start = ad ? noonISO(d) : londonISO(d, fd.get("t") || "09:00");
      const end = ad ? noonISO(addDays(d, Math.max(1, Number(fd.get("days")) || 1)))
        : new Date(new Date(start).getTime() + Math.max(15, Number(fd.get("len")) || 60) * 60000).toISOString();
      const row = {
        kind: fd.get("kind"), customer_id: cust, job_id: link, all_day: ad, starts_at: start, ends_at: end,
        title: String(fd.get("title") || "").trim() || null, address: String(fd.get("address") || "").trim() || null,
        notes: String(fd.get("notes") || "").trim() || null,
      };
      const ok = ev ? await save("events", ev.id, row) : await create("events", row);
      if (!ok) return false;
      if (!ev && link) {
        const j = jobById(link);
        if (row.kind === "quote_visit" && j?.stage === "new") await save("jobs", link, { stage: "visit_booked" });
        if (row.kind === "job" && (j?.stage === "won" || j?.stage === "quoted" || j?.stage === "new" || j?.stage === "visit_booked"))
          await save("jobs", link, { stage: "booked", job_date: d, won_at: j.won_at || todayKey() });
      }
      state.events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      toast(ev ? "Booking saved." : "Booking added.");
      route();
      return true;
    },
  });
}

async function setStage(job, stage) {
  const tk = todayKey();
  const patch = { stage };
  if (stage === "quoted" && !job.quoted_at) patch.quoted_at = tk;
  if (["won", "booked", "completed"].includes(stage) && !job.won_at) patch.won_at = tk;
  if (stage === "completed" && !job.completed_at) patch.completed_at = tk;
  if (stage === "lost" && !job.lost_at) patch.lost_at = tk;
  if (await save("jobs", job.id, patch)) { toast(`Moved to ${STAGES[stage].toLowerCase()}.`); route(); }
}

// ---------- Prices: one box, one tap ----------
function priceSheet(job) {
  const cu = customerById(job.customer_id);
  const tk = todayKey();
  const chaseOpen = state.events.find((e) => e.job_id === job.id && e.kind === "callback" && !e.done);
  openSheet({
    title: job.quote_amount != null ? "Change price" : "Add price",
    intro: `${esc(custName(cu))}${job.service ? `, ${esc(job.service)}` : ""}`,
    body: `<label class="pricebox"><span class="sr-only">Price quoted in pounds</span><span class="pound" aria-hidden="true">£</span>
        <input type="number" name="amt" inputmode="decimal" min="0" step="any" required value="${job.quote_amount ?? ""}" placeholder="0" autocomplete="off" enterkeyhint="done"></label>
      <p class="muted small">Sent ${prettyDay(job.quoted_at || tk).toLowerCase()}. ${chaseOpen ? "Your chase reminder stays as it is." : "We'll remind you to chase it in 3 days."}</p>
      <details class="more-opts"><summary>Change date or reminder</summary>
        <div class="stack" style="margin-top:10px">
          ${fld("Sent on", `<input class="input" type="date" name="d" value="${job.quoted_at || tk}">`)}
          <label class="check"><input type="checkbox" name="chase" ${chaseOpen ? "" : "checked"}> ${chaseOpen ? "Add another chase reminder" : "Remind me to chase it"}</label>
          ${fld("Chase on", `<input class="input" type="date" name="cd" value="${addDays(tk, 3)}">`)}
        </div></details>`,
    submit: "Save price",
    onSubmit: async (fd) => {
      const amt = Math.round(Number(String(fd.get("amt")).replace(/[£,\s]/g, "")) * 100) / 100;
      if (!(amt >= 0) || String(fd.get("amt")).trim() === "") { toast("Type the price, for example 650."); return false; }
      const stage = ["won", "booked", "completed"].includes(job.stage) ? job.stage : "quoted";
      if (!(await save("jobs", job.id, { stage, quote_amount: amt, quoted_at: fd.get("d") || job.quoted_at || tk }))) return false;
      const past = state.events.filter((e) => e.job_id === job.id && e.kind === "quote_visit" && !e.done && new Date(e.starts_at) < new Date());
      for (const e of past) await save("events", e.id, { done: true });
      if (stage === "quoted" && fd.get("chase") && fd.get("cd")) {
        await create("events", { kind: "callback", job_id: job.id, customer_id: cu?.id, all_day: true, starts_at: noonISO(fd.get("cd")), ends_at: noonISO(addDays(fd.get("cd"), 1)), title: `Chase quote (${gbp(amt)})` });
      } else if (chaseOpen) {
        await save("events", chaseOpen.id, { title: `Chase quote (${gbp(amt)})` });
      }
      toast(`Price saved: ${gbp(amt)}.`);
      route();
      return true;
    },
  });
  // Put the cursor straight in the price box
  setTimeout(() => document.querySelector('.pricebox input')?.focus(), 60);
}

async function acceptQuote(job) {
  const amt = job.quote_amount;
  if (!(await save("jobs", job.id, { stage: "won", won_amount: amt, won_at: todayKey() }))) return;
  await closeOpenEvents(job.id, ["callback"]);
  toast(`Won ${gbp(amt)}. <button class="link" style="color:inherit" data-step="book" data-job="${job.id}">Book the job date</button>`, 7000);
  route();
}

// The price line shown wherever a job appears
function priceStrip(job) {
  if (!job) return "";
  if (job.stage === "lost") return `<div class="pricebar is-lost"><span>Lost${job.lost_reason ? `: ${esc(job.lost_reason)}` : ""}</span></div>`;
  if (["won", "booked", "completed"].includes(job.stage)) {
    return `<div class="pricebar is-won"><span class="amt">${gbp(jobValue(job))}</span><span class="pb-label">${job.stage === "completed" ? "done and won" : "won"}</span>
      ${job.stage === "won" ? `<button class="btn small primary" data-step="book" data-job="${job.id}">Book the job</button>` : ""}</div>`;
  }
  if (job.quote_amount != null) {
    return `<div class="pricebar is-quoted">
      <button class="pb-amt" data-price="${job.id}" aria-label="Change price, now ${gbp(job.quote_amount)}"><span class="amt">${gbp(job.quote_amount)}</span><span class="pb-edit">Change</span></button>
      <div class="pb-ask"><span class="pb-label">Did they accept?</span>
        <div class="yn"><button class="btn primary" data-accept="${job.id}">${I.check}Yes</button><button class="btn" data-step="lost" data-job="${job.id}">No</button></div></div>
    </div>`;
  }
  return `<button class="btn primary price-add" data-price="${job.id}"><span class="pound-ico" aria-hidden="true">£</span>Add price</button>`;
}

// One handler for every CRM button. Returns true when it handled the click.
async function crmClick(t, e) {
  const d = t.dataset;
  if (d.price) { const j = jobById(d.price); if (j) { closeSheets(); priceSheet(j); } return true; }
  if (d.accept) { const j = jobById(d.accept); if (j) acceptQuote(j); return true; }
  if (d.priceCust) {
    // A customer with no open job: start one, then ask for the price
    const cu = customerById(d.priceCust);
    const job = await create("jobs", { customer_id: cu.id, address: cu.address || null, from_foner: cu.source === "foner_call" });
    if (job) priceSheet(job);
    return true;
  }
  if (d.step && d.job) { const j = jobById(d.job); if (j) { closeSheets(); stepSheet(d.step, j); } return true; }
  if (d.newjobCust) { addJobSheet({ customerId: d.newjobCust, callId: d.fromCall || null }); return true; }
  if (d.newJob) { addJobSheet({ callId: d.fromCall || null, customerOnly: !!d.customerOnly }); return true; }
  if (d.editJob) { const j = jobById(d.editJob); if (j) editJobSheet(j); return true; }
  if (d.editCust) { const c = customerById(d.editCust); if (c) editCustomerSheet(c); return true; }
  if (d.delJob) {
    if (!confirm("Delete this job and its bookings? This can't be undone.")) return true;
    if (await remove("jobs", d.delJob)) { state.events = state.events.filter((x) => x.job_id !== d.delJob); toast("Job deleted."); location.hash = "#/jobs"; }
    return true;
  }
  if (d.delCust) {
    if (!confirm("Delete this customer, their jobs and bookings? Their calls stay in Calls. This can't be undone.")) return true;
    if (await remove("customers", d.delCust)) { await loadCRM(true); toast("Customer deleted."); location.hash = "#/customers"; }
    return true;
  }
  if (d.newEvent) { eventSheet(null, { jobId: d.job || null, day: d.day || null }); return true; }
  if (d.evEdit) { const ev = state.events.find((x) => x.id === d.evEdit); if (ev) eventSheet(ev); return true; }
  if (d.evDel) {
    if (!confirm("Delete this booking?")) return true;
    if (await remove("events", d.evDel)) { closeSheets(); toast("Booking deleted."); route(); }
    return true;
  }
  if (d.evDone) {
    const ev = state.events.find((x) => x.id === d.evDone);
    if (ev && (await save("events", ev.id, { done: !ev.done }))) route();
    return true;
  }
  if (d.cal) {
    const tk = todayKey();
    if (d.cal === "today") state.calStart = mondayOf(tk);
    else if (d.cal.endsWith("month")) {
      const base = new Date(`${(state.calStart || tk).slice(0, 7)}-01T12:00:00Z`);
      base.setUTCMonth(base.getUTCMonth() + (d.cal.startsWith("-") ? -1 : 1));
      state.calStart = base.toISOString().slice(0, 10);
    } else state.calStart = addDays(state.calStart || mondayOf(tk), Number(d.cal));
    route();
    return true;
  }
  if (d.scroll) { e.preventDefault(); document.getElementById(d.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" }); return true; }
  if (d.jfilter) { state.jobFilter = d.jfilter; route(); return true; }
  if (d.jfilterGo) { state.jobFilter = d.jfilterGo; return false; }
  if (d.period) { state.moneyPeriod = d.period; route(); return true; }
  if (d.copyCal) {
    try { await navigator.clipboard.writeText(d.copyCal); toast("Calendar link copied. In Google Calendar choose Other calendars, then From URL."); }
    catch { toast(esc(d.copyCal)); }
    return true;
  }
  if (d.hide !== undefined && d.call) {
    const reason = d.hide || null;
    const call = state.calls.find((c) => c.id === d.call);
    const patch = reason ? { hidden_reason: reason, status: "handled", read_at: call?.read_at || new Date().toISOString() } : { hidden_reason: null };
    const { error } = await sb.from("calls").update(patch).eq("id", d.call);
    if (error) { toast(`Couldn't update: ${esc(error.message)}`); return true; }
    if (call) Object.assign(call, patch);
    if (reason) {
      toast(`Hidden as ${reason === "spam" ? "spam" : "a test call"}. <button class="link" style="color:inherit" data-hide="" data-call="${d.call}">Undo</button>`, 6000);
      location.hash = "#/calls";
    } else { toast("Call restored."); route(); }
    return true;
  }
  if (d.delCall) {
    if (!confirm("Delete this call permanently? Its notes go too. This can't be undone.")) return true;
    const { error } = await sb.from("calls").delete().eq("id", d.delCall);
    if (error) { toast(`Couldn't delete: ${esc(error.message)}`); return true; }
    state.calls = state.calls.filter((c) => c.id !== d.delCall);
    toast("Call deleted.");
    location.hash = "#/calls";
    return true;
  }
  if (d.unread) {
    const call = state.calls.find((c) => c.id === d.unread);
    if (call) call.read_at = null;
    await sb.from("calls").update({ read_at: null }).eq("id", d.unread);
    toast("Marked as unread.");
    location.hash = "#/calls";
    return true;
  }
  return false;
}

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "stage-sel") { const j = jobById(t.dataset.job); if (j && t.value !== j.stage) setStage(j, t.value); }
  if (t.matches?.("[data-allday]")) {
    const form = t.closest("form");
    const time = form?.querySelector('[name="t"]');
    if (time) time.disabled = t.checked;
  }
  if (t.matches?.("[data-toggle]")) {
    const box = document.getElementById(t.dataset.toggle);
    if (box) box.hidden = !t.checked;
  }
});

// ---------- router ----------
let routing = 0;
async function route() {
  const my = ++routing;
  const hash = location.hash || "#/";
  if (route.lastHash !== hash) document.querySelectorAll(".scrim").forEach((s) => s.remove());
  if (!hash.startsWith("#/")) return; // auth redirect fragments are handled by supabase-js
  if (state.recovery) { app.innerHTML = viewSetPassword(); return; }
  if (!state.session) { app.innerHTML = viewLogin(); return; }
  if (!state.clients.length) { app.innerHTML = viewNoBusiness(); return; }
  const [, page, id] = hash.split("/");
  let html;
  try {
    await Promise.all([loadCalls(), loadCRM()]);
    if (page === "calls" && id) html = await viewCallDetail(id);
    else if (page === "calls") html = viewCalls();
    else if (page === "jobs" && id) html = await viewJob(id);
    else if (page === "jobs") html = viewJobs();
    else if (page === "customers" && id) html = await viewCustomer(id);
    else if (page === "customers") html = viewCustomers();
    else if (page === "calendar") html = viewCalendar();
    else if (page === "money") html = viewMoney();
    else if (page === "more") html = viewMore();
    else if (page === "agent") { await loadRequests(); html = viewAgent(); }
    else if (page === "account") html = viewAccount();
    else if (page === "admin") html = await viewAdmin();
    else html = viewHome();
  } catch (e) {
    console.error(e);
    html = shell("home", `<div class="err-box" role="alert">Couldn't load your calls. Check your connection, then <button class="link" onclick="location.reload()">reload</button>.</div>`);
  }
  if (my !== routing || !html) return;
  const keepScroll = window.scrollY;
  const sameCallsPage = desktop.matches && page === "calls" && app.querySelector(".split");
  const listScroll = sameCallsPage ? app.querySelector(".split .pane")?.scrollTop : 0;
  app.innerHTML = html;
  const q = document.getElementById("q");
  if (q && document.activeElement !== q && state.query) { /* keep value */ }
  if (sameCallsPage) { const p = app.querySelector(".split .pane"); if (p) p.scrollTop = listScroll; }
  else if (route.lastHash !== hash) window.scrollTo(0, 0); else window.scrollTo(0, keepScroll);
  route.lastHash = hash;
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (await crmClick(t, e)) return;
  if (t.dataset.done) { e.preventDefault(); setHandled(t.dataset.done, true); return; }
  if (t.dataset.undone) { setHandled(t.dataset.undone, false); return; }
  if (t.dataset.undo) { setHandled(t.dataset.undo, false); return; }
  if (t.dataset.filter) { state.filter = t.dataset.filter; rerenderList(); return; }
  if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast("Number copied."); } catch { toast(t.dataset.copy); }
    return;
  }
  if (t.dataset.example) { const ta = document.getElementById("beh"); ta.value = t.dataset.example; ta.focus(); return; }
  if (t.dataset.audio) { playAudio(t.dataset.audio, t); return; }
  if (t.dataset.change) {
    const k = t.dataset.change;
    const c = client();
    const current = k === "notifications" ? c?.notification_email : c?.details?.[k];
    openSheet({
      title: `Change: ${sectionLabel(k).toLowerCase()}`,
      intro: "Tell us what it should say instead. foner updates your receptionist and marks this as done.",
      body: `<label class="field" for="chg">What should it be?</label><textarea id="chg" name="message" required maxlength="4000">${esc(current || "")}</textarea>`,
      submit: "Send change",
      onSubmit: (fd) => sendRequest({ kind: "business_details", section: k, message: String(fd.get("message")).trim() }).then((ok) => { if (ok && location.hash.startsWith("#/agent")) route(); return ok; }),
    });
    return;
  }
  if (t.dataset.suggestCall) {
    const rn = client()?.details?.receptionist_name || "the receptionist";
    openSheet({
      title: "Suggest a change",
      intro: `What should ${esc(rn)} have done differently on this call? foner reviews it and updates how calls are handled.`,
      body: `<label class="sr-only" for="sg">Your suggestion</label><textarea id="sg" name="message" required maxlength="4000" placeholder="For example: it should have asked for the postcode before the name."></textarea>`,
      submit: "Send suggestion",
      onSubmit: (fd) => sendRequest({ kind: "agent_behaviour", message: String(fd.get("message")).trim(), call_id: t.dataset.suggestCall }),
    });
    return;
  }
  if (t.id === "signout") { await sb.auth.signOut(); return; }
  if (t.id === "import") {
    t.disabled = true;
    const out = document.getElementById("import-out");
    out.textContent = "Importing. This can take a minute.";
    const { data, error } = await sb.functions.invoke("import-calls", { body: { client_id: state.clientId, days: 30 } });
    t.disabled = false;
    if (error) { out.textContent = "Import failed. Check the ELEVENLABS_API_KEY secret is set in Supabase."; return; }
    out.textContent = Object.entries(data.report || {}).map(([b, r]) => `${b}: ${r.imported} new of ${r.found} found`).join(". ") || "Nothing to import.";
    await Promise.all([loadCalls(true), loadCRM(true)]);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "biz") {
    state.clientId = e.target.value;
    store.set("foner.client", state.clientId);
    state.callsFor = null; state.requestsFor = null; state.crmFor = null;
    subscribe();
    const m = location.hash.match(/^#\/(calls|jobs|customers)\/.+/);
    if (m) location.hash = `#/${m[1]}`; else route();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "q") { state.query = e.target.value; rerenderList(); }
  if (e.target.id === "jq") { state.jobQuery = e.target.value; swapList("job-list", jobsListInner()); }
  if (e.target.id === "cq") { state.custQuery = e.target.value; swapList("cust-list", customersListInner()); }
});

function rerenderList() {
  const box = document.getElementById("call-list");
  if (!box) return route();
  const holder = box.parentElement;
  const current = (location.hash.split("/")[2]) || null;
  const tmp = document.createElement("div");
  tmp.innerHTML = callsListHtml(current);
  holder.querySelector(".filters").replaceWith(tmp.querySelector(".filters"));
  box.replaceWith(tmp.querySelector("#call-list"));
}

document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id === "login-form") {
    e.preventDefault();
    const fd = new FormData(f);
    const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Signing in";
    const { error } = await sb.auth.signInWithPassword({ email: String(fd.get("email")).trim(), password: String(fd.get("password")) });
    if (error) app.innerHTML = viewLogin(error.message.includes("Invalid") ? "That email and password don't match. Check both and try again." : error.message);
    return;
  }
  if (f.id === "setpw-form" || f.id === "pw-form") {
    e.preventDefault();
    const pw = String(new FormData(f).get("pw"));
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { toast(error.message); return; }
    toast("Password updated.");
    if (state.recovery) { state.recovery = false; history.replaceState(null, "", "#/"); route(); }
    f.reset();
    return;
  }
  if (f.dataset.note) {
    e.preventDefault();
    const body = String(new FormData(f).get("body")).trim();
    if (!body) return;
    const call = state.calls.find((c) => c.id === f.dataset.note);
    const { error } = await sb.from("call_notes").insert({ call_id: f.dataset.note, client_id: call?.client_id || state.clientId, author_email: state.email, body });
    if (error) { toast("Couldn't save the note. Try again."); return; }
    toast("Note saved.");
    route();
    return;
  }
  if (f.id === "behaviour-form") {
    e.preventDefault();
    const message = String(new FormData(f).get("message")).trim();
    if (!message) return;
    if (await sendRequest({ kind: "agent_behaviour", message })) route();
    return;
  }
  if (f.dataset.req) {
    e.preventDefault();
    const fd = new FormData(f);
    const { error } = await sb.from("change_requests").update({ status: fd.get("status"), admin_reply: String(fd.get("reply") || "").trim() || null }).eq("id", f.dataset.req);
    toast(error ? `Couldn't save: ${esc(error.message)}` : "Request updated.");
    if (!error) { state.requestsFor = null; route(); }
  }
});

async function playAudio(id, btn) {
  const box = document.getElementById("audio-box");
  btn.disabled = true; btn.lastChild.textContent = "Loading recording";
  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/call-audio?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_KEY },
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      box.innerHTML = `<p class="muted small">${esc(j.error || "The recording isn't available right now.")}</p>`;
      return;
    }
    const url = URL.createObjectURL(await r.blob());
    box.innerHTML = `<audio controls autoplay src="${url}"></audio>`;
  } catch {
    box.innerHTML = '<p class="muted small">The recording isn\'t available right now. Check your connection and try again.</p>';
  }
}

window.addEventListener("hashchange", route);
desktop.addEventListener("change", route);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.session && state.clientId) { await loadCalls(true); route(); }
});

// ---------- boot ----------
async function onSession(session) {
  state.session = session;
  state.email = session?.user?.email?.toLowerCase() || "";
  if (!session) {
    state.clients = []; state.calls = []; state.callsFor = null; state.requestsFor = null; state.isAdmin = false;
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    route();
    return;
  }
  try {
    const [{ data: admin }] = await Promise.all([sb.rpc("am_i_admin"), loadClients()]);
    state.isAdmin = admin === true;
  } catch (e) { console.error(e); }
  subscribe();
  if (!location.hash.startsWith("#/")) history.replaceState(null, "", "#/");
  route();
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    state.recovery = true; state.session = session;
    history.replaceState(null, "", "#/");
    route();
    return;
  }
  if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "INITIAL_SESSION") {
    if (event === "SIGNED_IN" && state.session?.user?.id === session?.user?.id && state.clients.length) return;
    setTimeout(() => onSession(session), 0);
  }
});
