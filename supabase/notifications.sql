-- Circle notifications: settings, devices, calendar link and upcoming meetings.
-- Run in Supabase → SQL Editor. (Also included at the end of schema.sql for new setups.)

-- Your notification preferences. Times are local "HH:MM".
create table if not exists public.circle_settings (
  user_id             uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  time_zone           text not null default 'America/Los_Angeles',
  brief_time          text not null default '07:30',
  brief_weekends      boolean not null default false,
  quiet_start         text not null default '21:00',
  quiet_end           text not null default '07:00',
  prompt_max_people   integer not null default 4,   -- 0 turns after-meeting prompts off
  last_brief_date     date,
  calendar_checked_at timestamptz,
  calendar_error      text,
  updated_at          timestamptz not null default now()
);
alter table public.circle_settings enable row level security;
drop policy if exists "Read own settings" on public.circle_settings;
create policy "Read own settings" on public.circle_settings for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Create own settings" on public.circle_settings;
create policy "Create own settings" on public.circle_settings for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Update own settings" on public.circle_settings;
create policy "Update own settings" on public.circle_settings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update on public.circle_settings to authenticated;
revoke all on public.circle_settings from anon;

-- The calendar's secret address. No policies: only the notify function (service role)
-- can read or write it, so it never travels back to any device.
create table if not exists public.circle_calendar_links (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  url        text not null,
  updated_at timestamptz not null default now()
);
alter table public.circle_calendar_links enable row level security;
revoke all on public.circle_calendar_links from anon, authenticated;

-- Devices that turned notifications on (Web Push subscriptions).
create table if not exists public.circle_push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.circle_push_subscriptions enable row level security;
drop policy if exists "Read own devices" on public.circle_push_subscriptions;
create policy "Read own devices" on public.circle_push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Add own devices" on public.circle_push_subscriptions;
create policy "Add own devices" on public.circle_push_subscriptions for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Remove own devices" on public.circle_push_subscriptions;
create policy "Remove own devices" on public.circle_push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);
grant select, insert, delete on public.circle_push_subscriptions to authenticated;
revoke all on public.circle_push_subscriptions from anon;

-- Upcoming meetings that include someone in Circle, kept up to date by the notify function.
create table if not exists public.circle_agenda (
  user_id        uuid not null references auth.users (id) on delete cascade,
  event_key      text not null,
  start_at       timestamptz not null,
  end_at         timestamptz not null,
  title          text,
  person_ids     text[] not null default '{}',
  attendee_count integer not null default 2,
  prompted       boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (user_id, event_key)
);
alter table public.circle_agenda enable row level security;
drop policy if exists "Read own agenda" on public.circle_agenda;
create policy "Read own agenda" on public.circle_agenda for select to authenticated using ((select auth.uid()) = user_id);
grant select on public.circle_agenda to authenticated;
revoke all on public.circle_agenda from anon;

-- Every 5 minutes, run the notify function. Replace <CRON_SECRET> with the value set
-- as the function's CRON_SECRET secret (it isn't stored in this repository).
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   select cron.schedule('circle-notify', '*/5 * * * *', $$
--     select net.http_post(
--       url := 'https://<project-ref>.supabase.co/functions/v1/notify',
--       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
--       body := '{}'::jsonb, timeout_milliseconds := 60000);
--   $$);
