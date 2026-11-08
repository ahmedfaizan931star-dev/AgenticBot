-- Connectors (encrypted tokens), uploaded files (extracted text), deep-research jobs.

create table if not exists public.connections (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'github')),
  token_enc text not null,
  refresh_enc text,
  expires_at timestamptz,
  label text,
  scopes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
-- Tokens are never readable by clients: RLS on, no policies. Only the service role touches this table.
alter table public.connections enable row level security;
revoke all on public.connections from anon, authenticated;

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) <= 200),
  mime text not null,
  bytes integer not null,
  text_content text not null,
  chars integer not null,
  created_at timestamptz not null default now()
);
create index if not exists files_user_idx on public.files (user_id, created_at desc);
alter table public.files enable row level security;
drop policy if exists files_select_own on public.files;
create policy files_select_own on public.files for select to authenticated using (user_id = auth.uid());
drop policy if exists files_delete_own on public.files;
create policy files_delete_own on public.files for delete to authenticated using (user_id = auth.uid());
revoke insert, update on public.files from anon, authenticated;

create table if not exists public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null references public.chats(id) on delete cascade,
  question text not null,
  phase text not null default 'plan' check (phase in ('plan', 'search', 'read', 'write', 'done', 'failed')),
  queries jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  error text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists research_jobs_chat_idx on public.research_jobs (chat_id, created_at desc);
alter table public.research_jobs enable row level security;
drop policy if exists jobs_select_own on public.research_jobs;
create policy jobs_select_own on public.research_jobs for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.research_jobs from anon, authenticated;
