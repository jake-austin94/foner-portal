-- Let business owners correct the details the receptionist collected on a call
-- (name, number, address, email, job, quote method, visit days, notes) when it misheard something.
-- Written 13 Nov 2026.
--
-- Until now owners could only change status / read / hidden / links on a call. Column-level UPDATE
-- grants stay deliberately narrow: summary, transcript, duration, ids etc. remain read-only.
-- The first time any of these fields is edited, what the receptionist originally captured is kept in
-- `original_details`, and `details_edited_at` records when. Re-imports can't overwrite edits
-- (ingest-call and import-calls both upsert with ignoreDuplicates).

alter table public.calls
  add column if not exists details_edited_at timestamptz,
  add column if not exists original_details  jsonb;

grant update (caller_name, caller_number, address, caller_email, service, quote_method, visit_preference, notes)
  on public.calls to authenticated;

create or replace function private.calls_details_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.caller_name, new.caller_number, new.address, new.caller_email, new.service, new.quote_method, new.visit_preference, new.notes)
     is distinct from
     (old.caller_name, old.caller_number, old.address, old.caller_email, old.service, old.quote_method, old.visit_preference, old.notes) then
    if old.original_details is null then
      new.original_details := jsonb_build_object(
        'caller_name', old.caller_name, 'caller_number', old.caller_number, 'address', old.address,
        'caller_email', old.caller_email, 'service', old.service, 'quote_method', old.quote_method,
        'visit_preference', old.visit_preference, 'notes', old.notes);
    end if;
    new.details_edited_at := now();
  end if;
  return new;
end $$;

drop trigger if exists calls_details_stamp on public.calls;
create trigger calls_details_stamp before update on public.calls
  for each row execute function private.calls_details_stamp();
