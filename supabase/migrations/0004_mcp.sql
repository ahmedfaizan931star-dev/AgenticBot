-- MCP connectors: remote MCP servers a user connects (cloud-side, Streamable HTTP).
create table if not exists public.mcp_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  slug text not null check (slug ~ '^[a-z0-9_]{1,24}$'),
  url text not null check (char_length(url) <= 2048),
  auth_type text not null check (auth_type in ('none', 'bearer', 'oauth')),
  secret_enc text,
  oauth_enc text,
  policy text not null default 'ask_unless_readonly' check (policy in ('ask_all', 'ask_unless_readonly')),
  status text not null default 'needs_review' check (status in ('active', 'needs_auth', 'needs_review', 'error')),
  tools jsonb not null default '[]'::jsonb,
  enabled_tools jsonb not null default '[]'::jsonb,
  tools_hash text,
  reviewed_hash text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
create index if not exists mcp_servers_user_idx on public.mcp_servers (user_id);
-- Holds encrypted credentials: no client access at all. Only the service role reads or writes it.
alter table public.mcp_servers enable row level security;
revoke all on public.mcp_servers from anon, authenticated;
