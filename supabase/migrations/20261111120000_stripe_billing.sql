-- Stripe billing for foner. Written 11 Nov 2026. NOT yet applied to the live project.
--
-- Stripe is the source of truth for money. These tables only mirror enough for the portal
-- to show "your plan is active until..." and for foner admins to see what needs attention.
-- Customers can READ their own billing row; nothing here is writable from the browser.
-- Every write comes from an Edge Function using the service role.

-- One row per business: the link between a foner client and its Stripe customer/subscription.
create table public.billing (
  client_id              uuid primary key references public.clients(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 text not null default 'none'
    check (status in ('none','incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
  billing_interval       text check (billing_interval in ('month','year')),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table public.billing enable row level security;
create policy billing_select on public.billing for select to authenticated
  using ((select private.can_see_client(client_id)));
create trigger billing_touch before update on public.billing
  for each row execute function private.touch_updated();

-- Every Stripe event we have received, so a retried delivery is never handled twice.
-- RLS on with no policies: only the service role can touch it.
create table public.stripe_events (
  id           text primary key,          -- evt_...
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);
alter table public.stripe_events enable row level security;

-- Things a human at foner should look at: failed payments, disputes, refunds, fraud warnings.
create table public.billing_alerts (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid references public.clients(id) on delete set null,
  kind             text not null
    check (kind in ('payment_failed','dispute','refund','fraud_warning','unknown_customer')),
  stripe_object_id text not null,         -- in_..., dp_..., ch_..., issfr_...
  detail           text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  unique (kind, stripe_object_id)
);
create index billing_alerts_open on public.billing_alerts (created_at desc) where resolved_at is null;
alter table public.billing_alerts enable row level security;
create policy billing_alerts_admin_select on public.billing_alerts for select to authenticated
  using ((select private.is_admin()));
create policy billing_alerts_admin_update on public.billing_alerts for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Extra minutes bought or billed on top of the plan (top-ups and overage), as invoice items.
create table public.billing_charges (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients(id) on delete cascade,
  kind                   text not null check (kind in ('topup','overage')),
  minutes                integer not null check (minutes > 0),   -- minutes this charge covers
  quantity               integer not null check (quantity > 0),  -- what was sent to Stripe (packs, or minutes)
  period_from            date,                                   -- overage only
  period_to              date,                                   -- overage only
  stripe_invoice_item_id text not null,
  created_at             timestamptz not null default now()
);
-- The same month can only be billed for overage once, even if an admin taps the button twice.
create unique index billing_charges_overage_once
  on public.billing_charges (client_id, period_from, period_to) where kind = 'overage';
alter table public.billing_charges enable row level security;
create policy billing_charges_select on public.billing_charges for select to authenticated
  using ((select private.can_see_client(client_id)));

-- Minutes used in a date range (UK time, inclusive) against the plan and any top-ups bought in that range.
-- Spam and test calls are left out. Each month's total is rounded up to the next whole minute.
-- Service role only: called by the stripe-invoice-item function.
create or replace function public.billing_usage(p_client uuid, p_from date, p_to date)
returns table (used_minutes integer, included_minutes integer, topup_minutes integer, overage_minutes integer)
language sql stable security invoker set search_path = public
as $$
  with u as (
    select coalesce(ceil(sum(duration_secs) / 60.0), 0)::int as used
    from public.calls
    where client_id = p_client
      and hidden_reason is null
      and started_at >= (p_from::timestamp at time zone 'Europe/London')
      and started_at <  ((p_to + 1)::timestamp at time zone 'Europe/London')
  ), t as (
    select coalesce(sum(minutes), 0)::int as topup
    from public.billing_charges
    where client_id = p_client and kind = 'topup'
      and created_at >= (p_from::timestamp at time zone 'Europe/London')
      and created_at <  ((p_to + 1)::timestamp at time zone 'Europe/London')
  ), c as (
    select plan_minutes from public.clients where id = p_client
  )
  select u.used, c.plan_minutes, t.topup, greatest(0, u.used - c.plan_minutes - t.topup)
  from u, t, c;
$$;
revoke all on function public.billing_usage(uuid, date, date) from public, anon, authenticated;
grant execute on function public.billing_usage(uuid, date, date) to service_role;
