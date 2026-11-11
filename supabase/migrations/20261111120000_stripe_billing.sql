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

-- Top-ups (30 extra call minutes for £10) added to a customer's Stripe invoice by a foner admin.
create table public.billing_charges (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients(id) on delete cascade,
  minutes                integer not null check (minutes > 0),   -- extra minutes this top-up covers
  quantity               integer not null check (quantity > 0),  -- packs of 30 sent to Stripe
  stripe_invoice_item_id text not null unique,                   -- a double tap can't record the same item twice
  created_at             timestamptz not null default now()
);
alter table public.billing_charges enable row level security;
create policy billing_charges_select on public.billing_charges for select to authenticated
  using ((select private.can_see_client(client_id)));
