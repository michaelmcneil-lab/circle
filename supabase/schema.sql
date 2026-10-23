-- Circle's database. Paste all of this into Supabase → SQL Editor → New query, then Run.

-- One row per person using Circle, holding all of their data.
create table if not exists public.circle_data (
  user_id    uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  data       jsonb       not null,
  revision   bigint      not null default 1,
  updated_at timestamptz not null default now()
);

-- Row-level security: a signed-in user can only ever see and change their own row.
alter table public.circle_data enable row level security;

drop policy if exists "Read own data" on public.circle_data;
create policy "Read own data" on public.circle_data
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Create own data" on public.circle_data;
create policy "Create own data" on public.circle_data
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Update own data" on public.circle_data;
create policy "Update own data" on public.circle_data
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, insert, update on public.circle_data to authenticated;
revoke all on public.circle_data from anon;

-- Safety net: before the first change each day, keep a copy of the previous version.
create table if not exists public.circle_backups (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  data       jsonb       not null,
  revision   bigint,
  created_at timestamptz not null default now()
);
alter table public.circle_backups enable row level security;

drop policy if exists "Read own backups" on public.circle_backups;
create policy "Read own backups" on public.circle_backups
  for select to authenticated using ((select auth.uid()) = user_id);
grant select on public.circle_backups to authenticated;
revoke all on public.circle_backups from anon;

create or replace function public.circle_daily_backup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.circle_backups
    where user_id = old.user_id and created_at > now() - interval '1 day'
  ) then
    insert into public.circle_backups (user_id, data, revision) values (old.user_id, old.data, old.revision);
  end if;
  return new;
end $$;

drop trigger if exists circle_daily_backup on public.circle_data;
create trigger circle_daily_backup before update on public.circle_data
  for each row execute function public.circle_daily_backup();

-- Photos: a private bucket, one folder per user, only the owner can read or change it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

drop policy if exists "Read own photos" on storage.objects;
create policy "Read own photos" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Add own photos" on storage.objects;
create policy "Add own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Replace own photos" on storage.objects;
create policy "Replace own photos" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Delete own photos" on storage.objects;
create policy "Delete own photos" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Inbox: notes waiting for review (see inbox.sql).
create table if not exists public.circle_inbox (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  source     text not null default 'quick-note',
  raw        text not null,
  status     text not null default 'processing' check (status in ('processing', 'ready', 'error')),
  suggestion jsonb,
  error      text
);
create index if not exists circle_inbox_user_created on public.circle_inbox (user_id, created_at);

-- Only the owner can see, add, update or clear their notes.
alter table public.circle_inbox enable row level security;

drop policy if exists "Read own inbox" on public.circle_inbox;
create policy "Read own inbox" on public.circle_inbox for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Add to own inbox" on public.circle_inbox;
create policy "Add to own inbox" on public.circle_inbox for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Update own inbox" on public.circle_inbox;
create policy "Update own inbox" on public.circle_inbox for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Clear own inbox" on public.circle_inbox;
create policy "Clear own inbox" on public.circle_inbox for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.circle_inbox to authenticated;
revoke all on public.circle_inbox from anon;

-- Shortcut keys (see shortcut-keys.sql).
create table if not exists public.circle_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token_hash   text not null unique,
  label        text not null default 'iPhone Shortcut',
  time_zone    text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.circle_tokens enable row level security;

drop policy if exists "Read own keys" on public.circle_tokens;
create policy "Read own keys" on public.circle_tokens for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Create own keys" on public.circle_tokens;
create policy "Create own keys" on public.circle_tokens for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Revoke own keys" on public.circle_tokens;
create policy "Revoke own keys" on public.circle_tokens for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, delete on public.circle_tokens to authenticated;
revoke all on public.circle_tokens from anon;

-- Notifications (see notifications.sql; the schedule needs the CRON_SECRET filled in).
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

-- Several calendars (see multiple-calendars.sql).
alter table public.circle_calendar_links add column if not exists id uuid not null default gen_random_uuid();
alter table public.circle_calendar_links add column if not exists label text not null default 'Calendar 1';
alter table public.circle_calendar_links add column if not exists last_error text;
alter table public.circle_calendar_links add column if not exists checked_at timestamptz;

-- One row per calendar instead of one per person.
alter table public.circle_calendar_links drop constraint if exists circle_calendar_links_pkey;
alter table public.circle_calendar_links add constraint circle_calendar_links_pkey primary key (id);
create unique index if not exists circle_calendar_links_user_url on public.circle_calendar_links (user_id, url);

-- Which calendar each upcoming meeting came from.
alter table public.circle_agenda add column if not exists calendar_label text;
