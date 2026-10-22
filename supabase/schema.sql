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
