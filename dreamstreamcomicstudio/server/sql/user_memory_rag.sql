-- Cross-product user memory (RAG foundation).
--
-- One durable, per-user memory store that follows the user across Chat Studio,
-- Code Studio and Comic Studio, across sessions and across AI models: facts and
-- preferences are distilled server-side, embedded, and retrieved per request to
-- be injected into ANY model's system prompt. Replaces the localStorage-only
-- memory (4KB, single device) as the canonical store.
--
-- Tenant isolation: RLS owner policies on both tables; the server uses the
-- service role and ALWAYS scopes queries by the authenticated user's id. The
-- match function takes the user id as an explicit parameter so a vector query
-- can never cross tenants.

create extension if not exists vector;

create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Which studio produced the memory (chat_studio | stream_studio | comic_studio).
  product text not null default 'chat_studio',
  session_id text,
  -- fact | preference | project | style — drives retrieval weighting later.
  kind text not null default 'fact',
  content text not null,
  content_hash text not null,
  -- gemini-embedding-001 @ 768 dims, L2-normalized. Null = lexical-only row
  -- (embedding provider unavailable at write time); still retrievable via FTS.
  embedding vector(768),
  importance real not null default 0.5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

create index if not exists user_memories_user_idx
  on public.user_memories (user_id, updated_at desc);
create index if not exists user_memories_embedding_idx
  on public.user_memories using hnsw (embedding vector_cosine_ops);
create index if not exists user_memories_fts_idx
  on public.user_memories using gin (to_tsvector('english', content));

alter table public.user_memories enable row level security;
drop policy if exists user_memories_owner on public.user_memories;
create policy user_memories_owner on public.user_memories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Per-user opt-out. Memory is ON by default; privacy-conscious users can switch
-- it off and the server then neither retrieves nor writes memories for them.
create table if not exists public.user_memory_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.user_memory_prefs enable row level security;
drop policy if exists user_memory_prefs_owner on public.user_memory_prefs;
create policy user_memory_prefs_owner on public.user_memory_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Cosine similarity retrieval, tenant-scoped by parameter (service-role caller).
create or replace function public.match_user_memories(
  p_user_id uuid,
  p_embedding vector(768),
  p_limit int default 8
) returns table (
  id uuid,
  product text,
  kind text,
  content text,
  similarity double precision,
  updated_at timestamptz
)
language sql
stable
as $$
  select m.id, m.product, m.kind, m.content,
         1 - (m.embedding <=> p_embedding) as similarity,
         m.updated_at
  from public.user_memories m
  where m.user_id = p_user_id
    and m.embedding is not null
  order by m.embedding <=> p_embedding
  limit greatest(1, least(p_limit, 50));
$$;
