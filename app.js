// foner customer portal — plain JS, no build step.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, SUPPORT_EMAIL } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const TZ = "Europe/London";
const LIST_COLS =
  "id,client_id,started_at,duration_secs,kind,title,summary,caller_name,caller_number,caller_id_number,address,caller_email,service,quote_method,visit_preference,notes,ended_reason,status,handled_at,handled_by,source";

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
  channel: null,
  filter: "todo",
  query: "",
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

function numberOf(c) { return c.caller_number || c.caller_id_number || ""; }
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
const gbp = (n) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(n);

// ---------- icons ----------
const I = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  calls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M19.5 19c0 1.5-2 2.5-5 2.5"/></svg>',
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></svg>',
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
      route();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "change_requests", filter: `client_id=eq.${state.clientId}` }, (p) => {
      const i = state.requests.findIndex((r) => r.id === p.new.id);
      if (i >= 0) { state.requests[i] = p.new; if (location.hash.startsWith("#/agent")) route(); }
    })
    .subscribe();
}

const todo = () => state.calls.filter((c) => c.status === "new" && c.kind !== "silent");

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
  const n = todo().length;
  const items = [
    ["home", "#/", "Home", I.home],
    ["calls", "#/calls", "Calls", I.calls],
    ["agent", "#/agent", "Receptionist", I.agent],
    ["account", "#/account", "Account", I.account],
  ];
  if (state.isAdmin) items.push(["admin", "#/admin", "Admin", I.admin]);
  const link = ([k, href, label, icon], rail) =>
    `<a href="${href}" ${k === active ? 'aria-current="page"' : ""}>${icon}<span>${label}</span>${
      k === "calls" && n ? (rail ? `<span class="dot">${n}</span>` : `<span class="dot" aria-label="${n} to do">${n}</span>`) : ""
    }</a>`;
  return {
    rail: `<nav class="rail" aria-label="Main">${items.map((i) => link(i, true)).join("")}<div class="foot">Need a hand? <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></div></nav>`,
    tabs: `<nav class="tabs" aria-label="Main">${items.map((i) => link(i, false)).join("")}</nav>`,
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
  return `<a class="card call k-${c.kind} ${isNew ? "is-new" : "is-handled"}" href="#/calls/${c.id}" ${current ? 'aria-current="true"' : ""}>
    <span class="stripe" aria-hidden="true"></span>
    <span class="body">
      <span class="name" style="display:block">${esc(displayName(c))}${isNew ? '<span class="sr-only"> (to do)</span>' : ""}</span>
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
      <button class="btn icon" data-done="${c.id}" aria-label="Mark ${esc(displayName(c))} as done">${I.check}</button>
    </div>
  </article>`;
}

function viewHome() {
  const c = client();
  const list = todo();
  const n = list.length;
  const ms = monthStart();
  const month = state.calls.filter((x) => new Date(x.started_at) >= ms);
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

  const value = c?.avg_job_value && enquiries
    ? `<p class="value-line"><strong>${enquiries} ${enquiries === 1 ? "enquiry" : "enquiries"}</strong> caught this month. At your average job of ${gbp(c.avg_job_value)}, that's up to <strong>${gbp(enquiries * c.avg_job_value)}</strong> of work to quote for.</p>`
    : "";

  const recent = state.calls.filter((x) => x.status === "handled" && x.kind !== "silent").slice(0, 3);

  return shell("home", `
    <section class="band"><div class="band-inner">
      <p class="hello">${greeting()}${c?.owner_name ? `, ${esc(c.owner_name)}` : ""}</p>
      <h1 class="headline">${head}</h1>
    </div></section>
    <div class="page lift">
      ${tickets}
      <section class="section" aria-labelledby="m-h">
        <div class="section-head"><h2 id="m-h">This month</h2></div>
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
      ${recent.length ? `<section class="section" aria-labelledby="r-h">
        <div class="section-head"><h2 id="r-h">Recently done</h2><a href="#/calls">All calls</a></div>
        <div class="list">${recent.map((x) => callRow(x)).join("")}</div>
      </section>` : ""}
    </div>`, { bare: true });
}

function filteredCalls() {
  const q = state.query.trim().toLowerCase();
  return state.calls.filter((c) => {
    if (state.filter === "todo" && !(c.status === "new" && c.kind !== "silent")) return false;
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
  const f = [["todo", `To do (${todo().length})`], ["all", "All"], ["enquiry", "Enquiries"], ["message", "Messages"], ["no_details", "No details"]];
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
  if (local) c.status = local.status;
  const { data: notes } = await sb.from("call_notes").select("*").eq("call_id", id).order("created_at");
  const biz = client();
  const num = numberOf(c);
  const wa = waLink(num);
  const isNew = c.status === "new";
  const facts = [
    ["Name", c.caller_name && esc(c.caller_name)],
    ["Number", num && `<a href="tel:${digits(num)}">${esc(prettyNumber(num))}</a>${!c.caller_number ? ' <span class="muted small">(caller ID)</span>' : ""}`],
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
    <a class="back" href="#/calls">${I.back}Calls</a>
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
    await loadCalls();
    if (page === "calls" && id) html = await viewCallDetail(id);
    else if (page === "calls") html = viewCalls();
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
    await loadCalls(true);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "biz") {
    state.clientId = e.target.value;
    store.set("foner.client", state.clientId);
    state.callsFor = null; state.requestsFor = null;
    subscribe();
    if (/^#\/calls\/.+/.test(location.hash)) location.hash = "#/calls"; else route();
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "q") { state.query = e.target.value; rerenderList(); }
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
