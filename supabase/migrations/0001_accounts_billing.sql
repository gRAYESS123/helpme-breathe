-- 0001_accounts_billing.sql
-- Help Me Breathe — accounts, subscriptions, trial ledger, embed tokens.
-- Run once in the Supabase SQL editor, on a project created after 2025-10-01
-- (asymmetric JWT signing keys by default).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles --
create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text,
  display_name          text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  marketing_opt_in      boolean not null default false,
  last_seen_at          timestamptz,
  deletion_requested_at timestamptz
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------- subscriptions --
-- `access_until` is the ONLY column the entitlement layer reads.
-- NOTE: user_id is nullable and does NOT cascade. A deleted account detaches
-- (user_id = null) so later webhooks for a still-live MoR subscription still
-- reconcile instead of becoming orphans.
create table if not exists public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references auth.users(id) on delete set null,
  provider                  text not null default 'paddle',
  provider_subscription_id  text not null,
  provider_customer_id      text,
  provider_price_id         text,
  plan                      text not null check (plan in
                              ('monthly','yearly','practitioner_yearly')),
  status                    text not null check (status in
                              ('trialing','active','past_due','paused','canceled','expired')),
  had_trial                 boolean not null default false,
  ever_paid                 boolean not null default false,   -- gates the past_due grace
  trial_started_at          timestamptz,
  trial_ends_at             timestamptz,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  next_billed_at            timestamptz,
  cancel_at                 timestamptz,
  canceled_at               timestamptz,
  paused_at                 timestamptz,
  resume_at                 timestamptz,
  past_due_since            timestamptz,
  access_until              timestamptz,
  -- What the provider actually charges this customer, as the provider states it.
  -- Tax-inclusive where the provider presents it that way. Never computed by us.
  display_amount            numeric(12,2),
  display_currency          text,
  display_tax_inclusive     boolean,
  dispute_open              boolean not null default false,
  live                      boolean not null default true,
  last_event_at             timestamptz,
  needs_reconcile           boolean not null default false,
  detached_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create index if not exists subscriptions_user_idx    on public.subscriptions (user_id);
create index if not exists subscriptions_access_idx  on public.subscriptions (user_id, access_until desc);
create index if not exists subscriptions_customer_idx on public.subscriptions (provider, provider_customer_id);
create index if not exists subscriptions_reconcile_idx
  on public.subscriptions (needs_reconcile) where needs_reconcile;

-- ------------------------------------------------------------------ devices --
-- No foreign key to auth.users on purpose: the row must outlive account
-- deletion or the device half of the lock is defeated by deleting the account.
-- Holds no email, no raw fingerprint. `device_id` is the uuid half of the
-- self-authenticating cookie (§5.1); a value whose MAC does not verify never
-- reaches this table.
create table if not exists public.devices (
  device_id           uuid primary key default gen_random_uuid(),
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  seen_count          integer not null default 1,
  free_sessions_used  integer not null default 0,   -- D1 counter
  trial_reserved_until timestamptz,
  trial_consumed_at   timestamptz,
  trial_count         integer not null default 0,   -- 2+ flips the soft signal hard
  trial_user_id       uuid,                         -- intentionally NOT a foreign key
  notes               text
);

create index if not exists devices_consumed_idx
  on public.devices (trial_consumed_at) where trial_consumed_at is not null;

-- ------------------------------------------------------------ trial_claims --
create table if not exists public.trial_claims (
  email_hash               bytea primary key,
  claimed_at               timestamptz not null default now(),
  reserved_until           timestamptz,
  outcome                  text not null default 'reserved'
                             check (outcome in ('reserved','started','converted',
                                                'cancelled','refunded','chargeback','expired')),
  device_id                uuid,
  user_id                  uuid,      -- intentionally NOT a foreign key
  provider                 text,
  provider_customer_id     text,
  provider_subscription_id text,
  updated_at               timestamptz not null default now()
);

create index if not exists trial_claims_user_idx   on public.trial_claims (user_id);
create index if not exists trial_claims_device_idx on public.trial_claims (device_id);

-- ------------------------------------------------------- checkout_intents --
-- THE SECURITY PIVOT. Commercial terms are decided here, server-side, and the
-- browser only ever carries an opaque reservation_id. Nothing in custom_data is
-- trusted on the way back (§5.4, §6.3).
create table if not exists public.checkout_intents (
  reservation_id  uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  email_hash      bytea,
  device_id       uuid,
  plan            text not null check (plan in ('monthly','yearly','practitioner_yearly')),
  trial_granted   boolean not null default false,
  price_id        text not null,
  provider        text not null,
  provider_transaction_id text,
  provider_customer_id    text,
  reasons         text[] not null default '{}',
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 minutes'),
  consumed_at     timestamptz
);

create index if not exists checkout_intents_user_idx on public.checkout_intents (user_id, created_at desc);
create index if not exists checkout_intents_txn_idx  on public.checkout_intents (provider, provider_transaction_id);

-- ------------------------------------------------------ embed credentials --
-- A subscriber manages a CREDENTIAL GROUP (embed_tokens). Each issued token is
-- its own row (embed_credentials) with its own jti, so rotation can expire the
-- old one after an overlap and revocation can kill every jti in the group.
create table if not exists public.embed_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  token_id      text not null unique,       -- the group id, shown on /account
  domains       text[] not null default '{}',
  label         text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  hit_count     bigint not null default 0,
  verify_count_30d bigint not null default 0   -- so the owner can see outsized volume
);

create table if not exists public.embed_credentials (
  jti          text primary key,
  token_id     text not null references public.embed_tokens(token_id) on delete cascade,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  superseded_at timestamptz,        -- set on rotation; hard-expires 48h later
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  hit_count    bigint not null default 0
);

create index if not exists embed_tokens_user_idx on public.embed_tokens (user_id);
create index if not exists embed_credentials_group_idx on public.embed_credentials (token_id);

-- ---------------------------------------------------------- webhook_events --
-- Idempotency, replay defence, RETRY LEDGER and a forensic trail for disputes.
-- `status` is a state machine: received -> processed | ignored | failed.
-- A `failed` row is re-claimable; a `processed` row is not.
create table if not exists public.webhook_events (
  provider     text not null,
  event_id     text not null,
  event_type   text,
  occurred_at  timestamptz,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  status       text not null default 'received'
                 check (status in ('received','processed','ignored','failed')),
  error        text,
  payload      jsonb,
  primary key (provider, event_id)
);

create index if not exists webhook_events_received_idx on public.webhook_events (received_at desc);
create index if not exists webhook_events_failed_idx
  on public.webhook_events (status, received_at desc) where status <> 'processed';

-- -------------------------------------------------------------- rate_limits --
-- api/_lib/ratelimit.js is in-memory and per-instance; its own header says it
-- "is not a security control". The endpoints that gate money use this instead.
create table if not exists public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

create or replace function public.bump_rate_limit(
  p_bucket text, p_window_seconds integer, p_limit integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = rate_limits.count + 1
  returning rate_limits.count into v_count;
  return v_count <= p_limit;   -- true = allowed
end;
$$;

-- ------------------------------------------------------------------- RLS ----
-- Every table: RLS enabled, and NOT ONE policy. The browser never reaches
-- PostgREST; only the secret key (which bypasses RLS) writes here, from api/*.
do $$
declare t text;
begin
  foreach t in array array['profiles','subscriptions','devices','trial_claims',
                           'checkout_intents','embed_tokens','embed_credentials',
                           'webhook_events','rate_limits']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke all on function public.bump_rate_limit(text, integer, integer) from anon, authenticated;

-- ------------------------------------------------------- updated_at touch ---
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists profiles_touch      on public.profiles;
drop trigger if exists subscriptions_touch on public.subscriptions;
drop trigger if exists trial_claims_touch  on public.trial_claims;

create trigger profiles_touch      before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();
create trigger trial_claims_touch  before update on public.trial_claims
  for each row execute function public.touch_updated_at();

-- ======================================================================= --
-- ADDENDUM (db-schema task, 2026-09-11) — hardening beyond the design's §3.2.
-- Everything above this line is the design document's SQL, verbatim. The
-- statements below add one closed door and change no behaviour.
--
-- Why: Postgres grants EXECUTE on every new function to PUBLIC by default, and
-- `anon` / `authenticated` are members of PUBLIC. The revoke above removes the
-- explicit Supabase default-privilege grants from those two roles, but they
-- would still inherit EXECUTE through PUBLIC. Because `bump_rate_limit` is
-- SECURITY DEFINER and PostgREST exposes every function in `public` at
-- `/rest/v1/rpc/<name>`, an anonymous caller holding the (public) publishable
-- key could otherwise fill any bucket it can name — for example
-- `trial:<user uuid>` or `trial:ip:<prefix>` — and deny a real customer their
-- trial. Revoking from PUBLIC closes that; the explicit grant keeps the secret
-- key (service_role) able to call it from api/*.
--
-- The two trigger functions need no such treatment: a function that returns
-- `trigger` cannot be invoked directly, by PostgREST or by anyone.
-- ======================================================================= --

revoke execute on function public.bump_rate_limit(text, integer, integer) from public;
grant  execute on function public.bump_rate_limit(text, integer, integer) to service_role;
