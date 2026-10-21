# foner portal (app.foner.uk)

The customer portal for foner, the AI phone receptionist for UK trades. Plain HTML, CSS and JavaScript (no build step), hosted on GitHub Pages, backed by the `foner` Supabase project.

## What customers can do

- **Home**: who to ring back, with one-tap Call / WhatsApp / done; this month's calls, enquiries, messages, minutes used against their plan, and (if an average job value is set) the value of enquiries caught.
- **Calls**: every call, filterable (to do, enquiries, messages, no details) and searchable; each call has caller details, summary, recording, full transcript, notes, and "mark as done".
- **Receptionist**: their AI number and what the receptionist knows; ask for changes to business details, or suggest how calls should be handled. Every request shows its progress and your reply.
- **Account**: plan, change password, add to home screen, help, sign out.
- **Admin** (foner only): all open requests across clients with status + reply, a business switcher, and "Import past calls".

## How data gets in

```
ElevenLabs post-call webhook → n8n "Roof & Render - Instant Call Email"
    ├─ existing email path (unchanged)
    └─ "Save Call to Portal" → Supabase function ingest-call
         (checks the ElevenLabs signature itself, finds the client by agent_id, stores the call)
```

Recordings are streamed on demand by the `call-audio` function (it checks the signed-in user can see the call first). They are never stored in Supabase.

## Supabase

- Project `foner`, ref `lkfriflskqyvwaknzbet`.
- Edge functions (source in `supabase/functions`): `ingest-call`, `call-audio`, `import-calls`.
- Secrets the functions need (Supabase → Edge Functions → Secrets):
  - `ELEVENLABS_WEBHOOK_SECRET`: the same signing secret the n8n Code node uses.
  - `ELEVENLABS_API_KEY`: an ElevenLabs key with read access to Conversational AI (for recordings and imports).
- Security: row-level security on every table. Owners see only their business (matched by their confirmed sign-in email in `client_members`); they can tick calls done, add notes and send requests, nothing else. Admins are listed in `admins`.

## Adding a customer to the portal

1. `clients` table: add or update the row (business name, owner first name, `agent_id`, AI number, notification email, plan, `details` JSON with `receptionist_name`, `services`, `areas`, `flags`, `never_says`, `hours`).
2. Supabase → Authentication → Users → **Add user** → email + temporary password, tick **Auto confirm**.
3. `client_members`: add `(client_id, email)` in lower case.
4. In the portal, Admin → **Import past calls** with that business selected.
5. Send them the link and temporary password; they can change it under Account.

## Local preview

Any static server works, e.g. `python3 -m http.server` in this folder, then open http://localhost:8000. Add `http://localhost:8000` to Supabase → Authentication → URL Configuration if you test sign-in emails.
