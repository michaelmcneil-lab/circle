-- Lets Circle keep every calendar event for the next 30 days (for "Coming up"),
-- including all-day ones, not just meetings with people in Circle.
-- Run once in Supabase → SQL Editor. Safe to run again.

alter table public.circle_agenda add column if not exists all_day boolean not null default false;
alter table public.circle_agenda add column if not exists start_date date; -- the date of an all-day event
create index if not exists circle_agenda_user_start on public.circle_agenda (user_id, start_at);
