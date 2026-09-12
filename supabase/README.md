# `supabase/` — the database migration

This folder holds the SQL that creates the Help Me Breathe accounts and billing
schema on Supabase (Postgres). It is applied by hand, once, from the Supabase
SQL editor. There is no migration runner, no CLI dependency and no npm package —
the repo's zero-runtime-dependency rule applies here too.

The schema itself is documented column by column in `docs/DB.md`. This file is
only about applying it.

```
supabase/
  migrations/
    0001_accounts_billing.sql   seven tables, one RPC function, RLS on everything, zero policies
  README.md                     this file
```

## Before you run it

1. The Supabase project must exist (owner checklist step 1 in the design
   document). Region is chosen once; `eu-central-1` is the recommendation.
2. **Settings → JWT Keys** must show an **asymmetric** signing key (ES256 or
   RS256). Projects created after 1 October 2025 default to this. If it says
   HS256, switch it before running anything — `api/_lib/supabase.js` refuses
   HS256 tokens on purpose.
3. Nothing in this folder needs the Supabase CLI, Docker, or a local Postgres.

## Running the migration

1. Open the project in the Supabase dashboard → **SQL Editor** → **New query**.
2. Paste the whole of `migrations/0001_accounts_billing.sql`.
3. Run it. It is safe to run twice: every `create table` is `if not exists`,
   every trigger is dropped before it is created, functions are `create or
   replace`, and the RLS / revoke block is idempotent.
4. Verify, using the queries below. Do not skip this — the whole security model
   of `api/*` rests on step 4 being true.

## Verifying (owner checklist step 6)

Run each of these in the SQL editor after the migration.

**All seven tables exist, with RLS enabled and forced:**

```sql
select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relname;
```

Expected: seven rows — `checkout_intents`, `devices`, `profiles`,
`rate_limits`, `subscriptions`, `trial_claims`, `webhook_events` — every one
with `rls_enabled = true` and `rls_forced = true`.

**Zero policies:**

```sql
select count(*) as policy_count from pg_policies where schemaname = 'public';
```

Expected: `0`. The Table Editor should show "RLS enabled" on every table and no
policies listed. If any policy exists, someone added it by hand; remove it. The
design's rule is *enabled, zero policies* — see `docs/DB.md` § "Security model".

**No table grants to the browser roles:**

```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;
```

Expected: no rows.

**The rate-limit function is callable only by the secret key:**

```sql
select grantee, privilege_type
from information_schema.routine_privileges
where specific_schema = 'public' and routine_name = 'bump_rate_limit'
order by grantee;
```

Expected: `service_role` (and the owning `postgres` role). Neither `anon`,
`authenticated` nor `PUBLIC` should appear.

**The function works:**

```sql
select public.bump_rate_limit('smoke:test', 60, 2);  -- true
select public.bump_rate_limit('smoke:test', 60, 2);  -- true
select public.bump_rate_limit('smoke:test', 60, 2);  -- false (third call in a 60 s window, limit 2)
delete from public.rate_limits where bucket = 'smoke:test';
```

**The profile trigger fires:** sign up once with a throwaway email via the
`/signin` page (or Authentication → Users → Add user in the dashboard) and
confirm a matching `public.profiles` row appears with the same `id` and `email`.

## What the migration deliberately does not do

- **No RLS policies.** The browser never talks to PostgREST; every read of
  product data goes through `GET /api/me`, which uses the secret key. Adding a
  policy "to make the Table Editor easier" reopens the door the design closed.
- **No foreign key from `devices` or `trial_claims` to `auth.users`.** Those
  rows must outlive an account, or deleting the account would reset the
  free-trial lock.
- **No cascade on `subscriptions.user_id`.** It is `on delete set null`, so a
  deleted account detaches its subscription row instead of orphaning every
  later webhook for a still-live merchant-of-record subscription.
- **No seed data, no views, no `pg_cron`.** Retention and reconciliation run as
  Vercel Crons in `api/cron/` (see `docs/DB.md` § "Retention and reconciliation").

## The addendum at the bottom of `0001`

The file is the design document's §3.2 SQL verbatim, followed by a short,
clearly marked addendum that revokes `EXECUTE` on `bump_rate_limit` from
`PUBLIC` and grants it to `service_role`. Postgres grants every new function to
`PUBLIC` by default and Supabase exposes every function in `public` as an RPC
endpoint, so without the addendum an anonymous caller could have filled any
rate-limit bucket it could name and denied a real customer their trial. The
addendum changes nothing else.

## How `0001` was tested before you run it

The file was executed end to end on a real Postgres engine (PGlite, Postgres
17 compiled to WebAssembly, run from a scratch directory — nothing was added to
this repo) against a stub `auth.users` table and stub `anon`, `authenticated`
and `service_role` (`bypassrls`) roles. Observed:

- runs clean, and runs clean a second time (idempotent);
- all seven tables have RLS enabled **and** forced, `pg_policies` is empty, and
  `anon` / `authenticated` hold no table privilege;
- `bump_rate_limit` answers `true, true, false` for limit 2, is executable by
  `service_role`, and is refused for `anon` ("permission denied for function");
  without the addendum below, `anon` **could** execute it, which is why the
  addendum exists;
- a `bypassrls` role that is not the table owner can insert into a forced
  table, and a plain granted role cannot ("new row violates row-level security
  policy") — so the two `security definer` functions work and the browser
  roles are shut out;
- inserting into `auth.users` creates the matching `profiles` row; deleting
  that user detaches its `subscriptions` row (`user_id = null`) and cascades
  `profiles`;
- the `updated_at` triggers fire, the `plan` / `status` check constraints
  reject bad values, the webhook claim statement from the design's §6.1
  re-claims a `received` row and returns zero rows for a `processed` one;
- all eight retention statements and the rollback script below parse and run.

Two things that harness could not prove and step 6 must: that `create extension
pgcrypto` succeeds in your project (PGlite has no pgcrypto, so that one line was
skipped; `gen_random_uuid()` is core Postgres since 13 either way), and that
the `postgres` role in the SQL editor carries `bypassrls` as Supabase's own
documentation states.

## Why `0001` still gets edited in place

**2026-09-12: `0001` has not been run anywhere** — not on production, not on a
staging project, not on a preview. Until it has, a correction to the schema is
an edit to this file, not a second migration. That is how the `plan` check
constraints on `subscriptions` and `checkout_intents` came to read
`('monthly','yearly')`: the design once carried a third value for a separate
professional plan, so that offering one would be a config change. The owner
closed that option on 2026-09-12 — one plan, everything included, billed
monthly or yearly — and the value was removed from `0001` rather than dropped
by a `0002`. The same decision retired two more tables that belonged to the
removed layer, and they came out of `0001` the same way — nine tables became
seven.

Once you have run `0001` against the real project, this stops being true: from
that moment every schema change is a new numbered file, per the section below.

## Adding a later migration

- Name it `NNNN_short_description.sql`, numbered after the last one. Apply in
  order, by hand, the same way.
- Keep it idempotent (`if not exists`, `create or replace`, `drop ... if exists`).
- Every new table gets the same treatment as the seven here: `enable row level
  security`, `force row level security`, `revoke all ... from anon,
  authenticated`, and **no policy**. Every new function in `public` gets
  `revoke execute ... from public` and an explicit grant to `service_role`.
- Never write a policy that reads `auth.uid()`. If a future feature genuinely
  needs the browser to read a table, that is a design change, not a migration.
- Never put a key, a pepper or a secret in a migration. Secrets live in Vercel
  environment variables only.
- Update `docs/DB.md` in the same change.

## Rolling back `0001`

There are no paying customers before this schema exists, so a rollback is a
drop, not a data migration. In the SQL editor, in this order:

```sql
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.touch_updated_at() cascade;
drop function if exists public.bump_rate_limit(text, integer, integer);
drop table if exists public.checkout_intents, public.webhook_events,
                     public.rate_limits, public.trial_claims, public.devices,
                     public.subscriptions, public.profiles;
```

Do **not** run this on a project that has ever had a real subscription; the
`trial_claims` and `devices` ledgers are the trial lock, and the
`subscriptions` rows are the only local record of what the merchant of record
is billing.
