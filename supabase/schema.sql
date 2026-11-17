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

-- ---------- How many people use the app (only the owner sees this, on /admin + a nightly push) ----------

-- One row per phone per Eastern day it opened the app. "device" is the same scrambled random ID as
-- reports: never a name, location or the real ID. Rows older than 90 days are deleted.
create table if not exists public.phone_days (
  device text not null,
  day text not null,                -- Eastern date, e.g. '2026-11-16'
  primary key (device, day)
);
alter table public.phone_days enable row level security;

-- The first day each phone was seen (for "new today" and "all time").
create table if not exists public.phones (
  device text primary key,
  first_day text not null
);
alter table public.phones enable row level security;

-- Small owner settings, e.g. which phone gets the nightly numbers and which devices aren't counted.
create table if not exists public.app_settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;

-- The numbers for the admin page: phones today, new today, last 7 days, all time, and a day-by-day list.
create or replace function public.phone_stats(p_today text, p_week_start text, p_exclude text[])
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'today', (select count(*) from public.phone_days where day = p_today and not (device = any (p_exclude))),
    'newToday', (select count(*) from public.phones where first_day = p_today and not (device = any (p_exclude))),
    'week', (select count(distinct device) from public.phone_days where day >= p_week_start and not (device = any (p_exclude))),
    'allTime', (select count(*) from public.phones where not (device = any (p_exclude))),
    'days', (
      select coalesce(json_agg(json_build_object('day', d.day, 'phones', d.n, 'new', d.nn) order by d.day desc), '[]'::json)
      from (
        select pd.day, count(*) as n, count(*) filter (where p.first_day = pd.day) as nn
        from public.phone_days pd join public.phones p on p.device = pd.device
        where pd.day >= p_week_start and not (pd.device = any (p_exclude))
        group by pd.day
      ) d
    )
  );
$$;
revoke execute on function public.phone_stats(text, text, text[]) from public, anon, authenticated;
