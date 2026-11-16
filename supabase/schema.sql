-- Hoos Riding database tables.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run again.
--
-- Security: every table has row level security ON and NO rules, so the public
-- ("publishable"/anon) key can't read or write anything. Only our server's secret key can.

-- ---------- Google usage counts (our own daily/monthly caps survive restarts) ----------

create table if not exists public.google_usage (
  kind text not null,               -- 'autocomplete' | 'placeDetails' | 'routes'
  period text not null,             -- a day '2026-11-12' or a month '2026-11'
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (kind, period)
);
alter table public.google_usage enable row level security;

-- Adds to a count in one step (safe even if two saves happen at once).
create or replace function public.add_google_usage(p_kind text, p_period text, p_amount integer)
returns void
language sql
set search_path = ''
as $$
  insert into public.google_usage (kind, period, count)
  values (p_kind, p_period, p_amount)
  on conflict (kind, period)
  do update set count = public.google_usage.count + excluded.count, updated_at = now();
$$;
revoke execute on function public.add_google_usage(text, text, integer) from public, anon, authenticated;

-- ---------- Rider reports (used from Phase 3 piece 4) ----------

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('packed', 'seats_open', 'broke_down', 'detour', 'skipped_stop', 'ramp_broken')),
  route_id integer,                 -- TransLoc route
  vehicle_id integer,               -- TransLoc bus (reports about a bus)
  stop_id integer,                  -- TransLoc stop (reports about a stop)
  device text not null,             -- anonymous: a scrambled (hashed) random phone ID, never a name or location
  expires_at timestamptz not null,
  removed boolean not null default false -- hidden by the admin (kept for abuse checks)
);
create index if not exists reports_live on public.reports (expires_at) where not removed;
alter table public.reports enable row level security;

-- "Still there?" answers: one per phone per report.
create table if not exists public.report_votes (
  report_id bigint not null references public.reports (id) on delete cascade,
  device text not null,
  still_there boolean not null,
  created_at timestamptz not null default now(),
  primary key (report_id, device)
);
alter table public.report_votes enable row level security;

-- ---------- Leave-now notifications (web push) ----------

-- One row per phone that turned reminders on. "endpoint" + keys = where to send a notification
-- (made by the phone's browser; it isn't a phone number or email). "plan" = the classes + start place
-- the reminders are worked out from (piece 2). Deleted when the phone turns reminders off.
create table if not exists public.push_subs (
  device text primary key,          -- anonymous: scrambled random phone ID
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  plan jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;

-- "This reminder was sent": one row per phone + class + day, so a restarted server (or two servers
-- running side by side during a deploy) never sends the same reminder twice. Old rows are deleted.
create table if not exists public.reminder_sends (
  device text not null,
  class_id text not null,
  day text not null,                -- Eastern date, e.g. '2026-11-16'
  sent_at timestamptz not null default now(),
  primary key (device, class_id, day)
);
alter table public.reminder_sends enable row level security;
