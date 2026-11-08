-- Write actions with human approval, audit log, connector modes, tool-message metadata.

alter table public.messages add column if not exists meta jsonb;

alter table public.connections add column if not exists mode text not null default 'read' check (mode in ('read', 'write'));

create table if not exists public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  tool_call_id text not null,
  tool text not null,
  args jsonb not null,
  summary text not null,
  preview text,
  status text not null default 'pending' check (status in ('pending', 'executing', 'done', 'denied', 'expired', 'failed')),
  result text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  decided_at timestamptz
);
create index if not exists pending_actions_chat_idx on public.pending_actions (chat_id, created_at desc);
create unique index if not exists pending_actions_call_idx on public.pending_actions (chat_id, tool_call_id);
alter table public.pending_actions enable row level security;
drop policy if exists actions_select_own on public.pending_actions;
create policy actions_select_own on public.pending_actions for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.pending_actions from anon, authenticated;

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_user_idx on public.audit_log (user_id, id desc);
alter table public.audit_log enable row level security;
drop policy if exists audit_select_own on public.audit_log;
create policy audit_select_own on public.audit_log for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.audit_log from anon, authenticated;
