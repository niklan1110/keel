-- Storage metadata. Layout matches Supabase Storage so policies written for
-- Supabase (e.g. using storage.foldername(name)) work unchanged. File bytes
-- live on the storage volume, not in Postgres.

create schema if not exists storage;
alter schema storage owner to keel_storage_admin;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  owner_id           text,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists bname on storage.buckets (name);

create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text not null references storage.buckets (id),
  name             text not null,
  owner            uuid,
  owner_id         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  version          text,
  user_metadata    jsonb
);
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
create index if not exists name_prefix_search on storage.objects (name text_pattern_ops);

alter table storage.buckets owner to keel_storage_admin;
alter table storage.objects owner to keel_storage_admin;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text) returns text
language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;

create or replace function storage.extension(name text) returns text
language plpgsql immutable as $$
declare
  _filename text;
begin
  select storage.filename(name) into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end
$$;

alter function storage.foldername(text) owner to keel_storage_admin;
alter function storage.filename(text) owner to keel_storage_admin;
alter function storage.extension(text) owner to keel_storage_admin;
grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text) to public;
