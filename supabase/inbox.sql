-- Circle's Inbox: notes waiting for your review. Paste into Supabase → SQL Editor → New query, then Run.
-- (Also included at the end of schema.sql for new setups.)

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
