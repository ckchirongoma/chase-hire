-- CVs, dedupe flags and the private `cvs` storage bucket.

create table public.cvs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null unique,
  file_name text,
  mime text not null,
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 5242880),
  file_sha256 text not null,
  status text not null default 'processing' check (status in ('processing', 'parsed', 'failed')),
  error text,
  text_extracted text,
  parsed jsonb,
  parse_model text,
  prompt_version text,
  injection_flags text[] not null default '{}',
  embedding extensions.vector(1536),
  embed_model text,
  -- Normalised identity fields used by the identity dedupe layer.
  id_email text,
  id_phone text,
  id_linkedin text,
  id_github text,
  created_at timestamptz not null default now()
);
alter table public.cvs enable row level security;
create index cvs_user_idx on public.cvs (user_id, created_at desc);
create index cvs_sha_idx on public.cvs (file_sha256);
create index cvs_identity_idx on public.cvs (id_email, id_phone, id_linkedin, id_github);
create index cvs_embedding_idx on public.cvs using hnsw (embedding extensions.vector_cosine_ops);

create policy cvs_owner_select on public.cvs
  for select to authenticated using (user_id = auth.uid());
create policy cvs_admin_select on public.cvs
  for select to authenticated using (public.is_admin());
-- Writes happen server-side only (service role).
grant select on public.cvs to authenticated;

create table public.dedupe_flags (
  id uuid primary key default gen_random_uuid(),
  cv_id uuid not null references public.cvs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  matched_cv_id uuid references public.cvs (id) on delete set null,
  matched_user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('exact_file', 'identity', 'semantic_high', 'semantic_review')),
  similarity numeric,
  matched_fields text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'merged', 'not_duplicate', 'blocked')),
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (cv_id, matched_user_id, kind)
);
alter table public.dedupe_flags enable row level security;
create index dedupe_flags_status_idx on public.dedupe_flags (status, created_at desc);

-- Admin only. A flag never blocks a candidate automatically; an admin resolves it.
create policy dedupe_admin_select on public.dedupe_flags
  for select to authenticated using (public.is_admin());
create policy dedupe_admin_update on public.dedupe_flags
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.dedupe_flags to authenticated;
grant update (status, note, resolved_by, resolved_at) on public.dedupe_flags to authenticated;

-- Semantic dedupe lookup; called by the server (service role) only.
create or replace function public.match_cvs(
  query_embedding extensions.vector(1536),
  exclude_user uuid,
  min_similarity double precision
)
returns table (cv_id uuid, user_id uuid, similarity double precision)
language sql
stable
set search_path = ''
as $$
  select c.id, c.user_id, 1 - (c.embedding operator(extensions.<=>) query_embedding)
  from public.cvs c
  where c.user_id <> exclude_user
    and c.embedding is not null
    and 1 - (c.embedding operator(extensions.<=>) query_embedding) >= min_similarity
  order by c.embedding operator(extensions.<=>) query_embedding
  limit 20;
$$;
revoke execute on function public.match_cvs(extensions.vector, uuid, double precision) from public, anon, authenticated;
grant execute on function public.match_cvs(extensions.vector, uuid, double precision) to service_role;

-- Storage: private bucket, 5 MB, PDF/DOCX only. Files live under cvs/{user_id}/.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cvs', 'cvs', false, 5242880,
  array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do nothing;

-- Upload only into your own folder, and only after accepting the consent notice (POPIA).
create policy cvs_owner_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cvs'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.consents c where c.user_id = auth.uid())
  );
create policy cvs_owner_read on storage.objects
  for select to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy cvs_admin_read on storage.objects
  for select to authenticated
  using (bucket_id = 'cvs' and public.is_admin());
