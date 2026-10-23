-- Lets Circle read several calendars (for example Personal and Family).
-- Run once in Supabase → SQL Editor. Safe to run again. An existing calendar is kept
-- and named "Calendar 1".

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
