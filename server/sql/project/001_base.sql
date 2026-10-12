-- Base layout for a Keel project database: extensions, API grants, internal schema.

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- Like Supabase, tables in `public` are reachable by the API roles and
-- row level security decides what each caller can see.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on routines to anon, authenticated, service_role;

-- Internal bookkeeping. Not exposed to API roles.
create schema if not exists _keel;
revoke all on schema _keel from public;
