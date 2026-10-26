-- Circle: the "New in Google" list remembers which contacts it has already offered.
-- Run in Supabase → SQL Editor (after google-contacts.sql). Safe to run again.
alter table public.circle_google add column if not exists google_seen jsonb;
