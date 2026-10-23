-- Circle ⇄ Google Contacts sync. Run in Supabase → SQL Editor.
-- None of these tables have policies: only the google-contacts function (service role)
-- can read or write them, so the Google sign-in never travels back to any device.

-- The Google connection and the state of the last run.
create table if not exists public.circle_google (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  refresh_token text,
  google_email  text,
  mode          text not null default 'off' check (mode in ('off', 'all')),
  running_until timestamptz,  -- a run in progress holds this, so two never overlap
  last_sync_at  timestamptz,
  last_error    text,
  last_result   jsonb,
  updated_at    timestamptz not null default now()
);
alter table public.circle_google enable row level security;
revoke all on public.circle_google from anon, authenticated;

-- Which Google contact each Circle person is linked to, and what both last agreed on.
create table if not exists public.circle_google_links (
  user_id          uuid not null references auth.users (id) on delete cascade,
  person_id        text not null,
  resource_name    text,
  status           text not null default 'linked' check (status in ('linked', 'google_deleted', 'circle_deleted', 'excluded')),
  etag             text,
  snapshot         jsonb not null default '{}',
  conflicts        jsonb not null default '[]',
  photo_synced     boolean not null default false,
  circle_photo_v   bigint,
  google_photo_url text,
  updated_at       timestamptz not null default now(),
  primary key (user_id, person_id)
);
create unique index if not exists circle_google_links_contact on public.circle_google_links (user_id, resource_name) where resource_name is not null;
alter table public.circle_google_links enable row level security;
revoke all on public.circle_google_links from anon, authenticated;

-- Google sign-ins in progress (each lasts a few minutes).
create table if not exists public.circle_google_oauth (
  state      text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.circle_google_oauth enable row level security;
revoke all on public.circle_google_oauth from anon, authenticated;
