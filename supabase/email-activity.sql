-- Circle: log emails with your people as conversations. Run in Supabase → SQL Editor
-- (after google-contacts.sql). Safe to run again.

alter table public.circle_google
  add column if not exists scopes           text,     -- what Google allowed at the last sign-in
  add column if not exists gmail_on         boolean not null default false,
  add column if not exists gmail_history_id text,     -- where in Gmail's history Circle has read up to
  add column if not exists gmail_checked_at timestamptz,
  add column if not exists gmail_error      text,
  add column if not exists gmail_last       jsonb;

alter table public.circle_google_oauth
  add column if not exists enable_email boolean not null default false;
