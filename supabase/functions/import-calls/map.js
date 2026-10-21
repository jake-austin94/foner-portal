// Turns an ElevenLabs post-call payload (`data` object) into a row for public.calls.
// Plain JS so it runs in both Deno (edge function) and Node (backfill script).

function clean(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'none' || s.toLowerCase() === 'n/a') return '';
  return s;
}

function toUkLocal(n) {
  let s = clean(n);
  if (s.indexOf('+44') === 0) s = '0' + s.slice(3);
  return s;
}

function quoteLabel(q) {
  if (!q) return '';
  if (q === 'photos_whatsapp') return 'Photos by WhatsApp';
  if (q === 'photos_email') return 'Photos by email';
  if (['visit', 'in_person', 'in-person', 'in_person_visit', 'in_person_appointment'].includes(q)) return 'In-person visit';
  const t = q.split('_').join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function endedLabel(reason) {
  const r = clean(reason);
  const rl = r.toLowerCase();
  if (!r) return '';
  if (rl.includes('end_call')) return 'Receptionist ended the call';
  if (rl.includes('silence')) return 'Ended after silence';
  if (rl.includes('remote party') || rl.includes('client disconnected')) return 'Caller hung up';
  return r.length > 120 ? r.slice(0, 120) : r;
}

export function mapCall(d, clientId) {
  const analysis = d.analysis || {};
  const dc = analysis.data_collection_results || {};
  const f = (id) => clean(dc[id] && dc[id].value);
  const meta = d.metadata || {};
  const phone = meta.phone_call || {};

  const transcriptIn = Array.isArray(d.transcript) ? d.transcript : [];
  const transcript = [];
  let callerSpoke = false;
  for (const m of transcriptIn) {
    const msg = clean(m && m.message);
    if (!msg) continue;
    const role = m.role === 'user' ? 'caller' : 'agent';
    if (role === 'caller') callerSpoke = true;
    transcript.push({ role, text: msg, t: Math.max(0, Math.round(Number(m.time_in_call_secs) || 0)) });
  }

  const callType = f('call_type');
  const name = f('customer_name');
  const address = f('customer_address_postcode');
  const email = f('customer_email');
  const number = toUkLocal(f('customer_mobile_number'));
  const service = f('service_requested');
  const visit = f('appointment_datetime');
  const notes = f('notes');
  const callerId = toUkLocal(phone.external_number);
  let quote = quoteLabel(f('quote_method'));
  if (!name && !address) quote = '';

  // Contact details = something the owner can act on (who / where / how to reach them)
  const gaveContact = !!(name || address || email || number);
  let kind = 'other';
  if (!callerSpoke) kind = 'silent';
  else if (callType.indexOf('message_for_') === 0) kind = gaveContact ? 'message' : 'no_details';
  else if (!gaveContact) kind = 'no_details';
  else if (callType === 'new_enquiry' || service || address) kind = 'enquiry';

  const startUnix = Number(meta.start_time_unix_secs) || Math.floor(Date.now() / 1000);

  return {
    client_id: clientId,
    conversation_id: String(d.conversation_id),
    agent_id: d.agent_id || null,
    started_at: new Date(startUnix * 1000).toISOString(),
    duration_secs: Math.max(0, Math.round(Number(meta.call_duration_secs) || 0)),
    kind,
    call_type: callType || null,
    title: clean(analysis.call_summary_title) || null,
    summary: clean(analysis.transcript_summary) || null,
    caller_name: name || null,
    caller_number: number || null,
    caller_id_number: callerId || null,
    address: address || null,
    caller_email: email || null,
    service: service || null,
    quote_method: quote || null,
    visit_preference: visit || null,
    notes: notes || null,
    ended_reason: endedLabel(meta.termination_reason) || null,
    transcript,
    source: clean(phone.type) || 'test',
    // Silent / hang-up-straight-away calls don't need following up
    status: kind === 'silent' ? 'handled' : 'new',
  };
}
