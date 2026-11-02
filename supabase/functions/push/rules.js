// When each reminder is due and what it says. No database or network here, so it can be tested on its own.
export const PRICE_HOUR = 18; // 6pm UK
export const CHASE_HOUR = 8; // 8am UK
export const MAX_SINGLE = 3; // more than this in one go becomes one summary
const STALE_DAYS = 14; // don't start nudging about jobs this old
const REPEAT_HOURS = 47; // second nudge at the 6pm run two days after the first
const H = 3600000;

export function ukParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const who = (c) => clip(c?.name || c?.phone, 40) || "A customer";
const possessive = (n) => n === "A customer" ? "a customer's" : /s$/i.test(n) ? `${n}'` : `${n}'s`;
const gbp = (n) => "£" + Number(n).toLocaleString("en-GB", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });

// jobs: [{id, stage, quote_amount, created_at}], visits: [{job_id, starts_at, done}], log: [{ref_id, sent_at}]
// Returns the jobs that should be nudged at this 6pm run. A booked visit waits until it has happened,
// and gets its own two nudges counted from the visit.
export function priceDue(jobs, visits, log, now) {
  const t = now.getTime();
  const due = [];
  for (const j of jobs) {
    if (!["new", "visit_booked"].includes(j.stage) || j.quote_amount != null) continue;
    const mine = visits.filter((v) => v.job_id === j.id);
    if (mine.some((v) => !v.done && Date.parse(v.starts_at) > t)) continue;
    const anchor = Math.max(Date.parse(j.created_at), ...mine.map((v) => Date.parse(v.starts_at)).filter((x) => x <= t));
    if (anchor > t || t - anchor > STALE_DAYS * 24 * H) continue;
    const sent = log.filter((l) => l.ref_id === j.id && Date.parse(l.sent_at) > anchor).map((l) => Date.parse(l.sent_at)).sort((a, b) => a - b);
    if (sent.length === 0) due.push(j);
    else if (sent.length === 1 && t - sent[0] >= REPEAT_HOURS * H) due.push(j);
  }
  return due;
}

// events: [{kind, done, starts_at, job}] with job = {stage} or null. Fires on the chase day only.
export function chaseDue(events, today) {
  return events.filter((e) => e.kind === "callback" && !e.done && ukParts(new Date(e.starts_at)).date === today
    && !["won", "booked", "completed", "lost"].includes(e.job?.stage));
}

export function callMessage(c) {
  const name = clip(c.caller_name || c.caller_number || c.caller_id_number, 40);
  const fallback = c.kind === "no_details" ? "They didn't leave any details." : "Tap to see the details.";
  return { title: name ? `New call: ${name}` : "New call", body: clip(c.summary, 140) || fallback, url: `#/calls/${c.id}`, tag: `call-${c.id}` };
}

const PRICE_BODY = "Already priced it? Add it to foner and we'll remind you to chase.";
export function priceMessage(j) {
  return { title: `${who(j.customer)} still needs a price`, body: PRICE_BODY, url: `#/jobs/${j.id}/price`, tag: `price-${j.id}` };
}
export function priceSummary(n) {
  return { title: `${n} jobs still need a price`, body: "Already priced them? Add them to foner and we'll remind you to chase.", url: "#/jobs", tag: "price-summary" };
}
export function chaseMessage(e) {
  const name = who(e.customer);
  const url = e.job_id ? `#/jobs/${e.job_id}` : "#/calendar";
  const amt = e.job?.quote_amount;
  if (e.job?.stage === "quoted" || /^chase/i.test(e.title || "")) {
    return { title: amt != null ? `Chase ${possessive(name)} ${gbp(amt)} quote` : `Chase ${possessive(name)} quote`, body: "Today's the day to follow it up. Tap to open the job.", url, tag: `chase-${e.id}` };
  }
  return { title: `Call back ${name}`, body: clip(e.title, 140) || "You set a reminder for today.", url, tag: `chase-${e.id}` };
}
export function chaseSummary(n) {
  return { title: `${n} quotes to follow up today`, body: "Tap to see who to ring.", url: "#/", tag: "chase-summary" };
}
