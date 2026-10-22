-- Keys that let an iPhone Shortcut send notes to your Circle Inbox without signing in.
-- Paste into Supabase → SQL Editor → New query, then Run.
-- (Also included at the end of schema.sql for new setups.)
--
-- Only a fingerprint (SHA-256 hash) of each key is stored, never the key itself.
-- A key can only add notes to the Inbox; it can't read or change anything in Circle.

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
