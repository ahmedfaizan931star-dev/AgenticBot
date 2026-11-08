-- Agent Hub: schema, RLS, atomic credits, rate limiting.
-- Run once in Supabase SQL editor (or via supabase db push).

create extension if not exists pgcrypto;

-- ───────── Profiles ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- ───────── Credits ─────────
create table if not exists public.credits_balance (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.credits_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason text not null,
  ref text not null,
  created_at timestamptz not null default now(),
  unique (user_id, ref)
);
create index if not exists credits_ledger_user_idx on public.credits_ledger (user_id, created_at desc);

-- ───────── Chats / messages / memories ─────────
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chats_user_idx on public.chats (user_id, updated_at desc);

create table if not exists public.messages (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text,
  tool_calls jsonb,
  tool_call_id text,
  tool_name text,
  is_error boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_chat_idx on public.messages (chat_id, seq);

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists memories_user_idx on public.memories (user_id, created_at desc);

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);

-- ───────── Row level security ─────────
alter table public.profiles enable row level security;
alter table public.credits_balance enable row level security;
alter table public.credits_ledger enable row level security;
alter table public.chats enable row level security;
alter table public.messages enable row level security;
alter table public.memories enable row level security;
alter table public.rate_limits enable row level security;  -- no policies: service role only

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());

drop policy if exists balance_select_own on public.credits_balance;
create policy balance_select_own on public.credits_balance for select to authenticated using (user_id = auth.uid());

drop policy if exists ledger_select_own on public.credits_ledger;
create policy ledger_select_own on public.credits_ledger for select to authenticated using (user_id = auth.uid());

drop policy if exists chats_select_own on public.chats;
create policy chats_select_own on public.chats for select to authenticated using (user_id = auth.uid());
drop policy if exists chats_update_own on public.chats;
create policy chats_update_own on public.chats for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists chats_delete_own on public.chats;
create policy chats_delete_own on public.chats for delete to authenticated using (user_id = auth.uid());

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages for select to authenticated using (user_id = auth.uid());

drop policy if exists memories_select_own on public.memories;
create policy memories_select_own on public.memories for select to authenticated using (user_id = auth.uid());
drop policy if exists memories_delete_own on public.memories;
create policy memories_delete_own on public.memories for delete to authenticated using (user_id = auth.uid());

-- Clients can never write balances, ledger rows, messages or memories directly.
revoke insert, update, delete on public.credits_balance, public.credits_ledger, public.profiles from anon, authenticated;
revoke insert on public.chats, public.messages, public.memories from anon, authenticated;
revoke update on public.messages, public.memories from anon, authenticated;
revoke all on public.rate_limits from anon, authenticated;

-- ───────── Credit functions (service role only) ─────────
create or replace function public.grant_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_balance integer;
begin
  if p_amount <= 0 then raise exception 'invalid_amount'; end if;
  insert into credits_ledger (user_id, delta, reason, ref) values (p_user, p_amount, p_reason, p_ref)
    on conflict (user_id, ref) do nothing;
  if not found then
    select balance into v_balance from credits_balance where user_id = p_user;
    return coalesce(v_balance, 0);
  end if;
  insert into credits_balance (user_id, balance) values (p_user, p_amount)
    on conflict (user_id) do update set balance = credits_balance.balance + p_amount, updated_at = now()
    returning balance into v_balance;
  return v_balance;
end $$;

create or replace function public.spend_credits(p_user uuid, p_amount integer, p_reason text, p_ref text)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_balance integer;
begin
  if p_amount <= 0 then raise exception 'invalid_amount'; end if;
  -- Idempotent: the same ref never charges twice.
  if exists (select 1 from credits_ledger where user_id = p_user and ref = p_ref) then
    select balance into v_balance from credits_balance where user_id = p_user;
    return coalesce(v_balance, 0);
  end if;
  update credits_balance set balance = balance - p_amount, updated_at = now()
    where user_id = p_user and balance >= p_amount
    returning balance into v_balance;
  if not found then raise exception 'insufficient_credits'; end if;
  insert into credits_ledger (user_id, delta, reason, ref) values (p_user, -p_amount, p_reason, p_ref);
  return v_balance;
end $$;

-- Refund exactly what a given spend ref charged, once.
create or replace function public.refund_credits(p_user uuid, p_ref text)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_spent integer; v_balance integer;
begin
  select -delta into v_spent from credits_ledger where user_id = p_user and ref = p_ref and delta < 0;
  if v_spent is null then
    select balance into v_balance from credits_balance where user_id = p_user;
    return coalesce(v_balance, 0);
  end if;
  insert into credits_ledger (user_id, delta, reason, ref) values (p_user, v_spent, 'refund', 'refund:' || p_ref)
    on conflict (user_id, ref) do nothing;
  if not found then
    select balance into v_balance from credits_balance where user_id = p_user;
    return coalesce(v_balance, 0);
  end if;
  update credits_balance set balance = balance + v_spent, updated_at = now()
    where user_id = p_user returning balance into v_balance;
  return v_balance;
end $$;

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_hits integer;
begin
  insert into rate_limits (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then 1 else rate_limits.hits + 1 end,
    window_start = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then now() else rate_limits.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

revoke all on function public.grant_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.spend_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.refund_credits(uuid, text) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.grant_credits(uuid, integer, text, text) to service_role;
grant execute on function public.spend_credits(uuid, integer, text, text) to service_role;
grant execute on function public.refund_credits(uuid, text) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- ───────── New user: profile + 50 free credits ─────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email) values (new.id, new.email) on conflict do nothing;
  insert into credits_balance (user_id, balance) values (new.id, 0) on conflict do nothing;
  perform grant_credits(new.id, 50, 'signup_bonus', 'signup:' || new.id::text);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- To add credits manually (SQL editor):
--   select grant_credits('<user uuid>', 500, 'manual_grant', 'manual:' || gen_random_uuid()::text);
