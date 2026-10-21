# Database migrations

Applied to the `foner` Supabase project (ref `lkfriflskqyvwaknzbet`) on 21 Oct 2026:

| Version | Name | What it does |
|---|---|---|
| 20261021132606 | portal_core_schema | Tables (clients, client_members, admins, calls, call_notes, change_requests), private helper functions, triggers, row-level security, realtime |
| 20261021134532 | notify_change_requests | pg_net trigger that posts each new change request to the n8n workflow "foner - Portal change request alert" |

The SQL is stored in Supabase (Database → Migrations). To copy it into this folder, run
`supabase link --project-ref lkfriflskqyvwaknzbet && supabase db pull`.
