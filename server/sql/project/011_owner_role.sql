-- The project's owner role, <database>_owner (my_app_owner for my_app): what
-- Studio > Connect and the AI agent prompt hand out instead of the postgres
-- superuser. keel-migrate creates it (with its password) before this runs.
--
-- It owns the public schema and everything in it, can create schemas and
-- trusted extensions, write row level security policies, security definer
-- functions and triggers on auth.users, add its tables to the
-- supabase_realtime publication and read and write the auth, storage and
-- realtime tables, like Supabase's postgres role. It is not a superuser: no
-- COPY ... PROGRAM, no files on the server, no other project's database.
-- It does not bypass row level security (BYPASSRLS would reach other
-- projects' rows in the control database); policies on storage and realtime
-- give it every row instead (012_owner_policies.sql), so migrations can
-- still insert into storage.buckets.

create or replace function _keel.owner_role() returns name
language sql stable as $$
  select (current_database() || '_owner')::name
$$;

-- Hands one object in `public` that a superuser owns (made in Studio, with
-- ./keel psql, by a restore) to the owner role, so migrations run as the
-- owner can change it. Objects that belong to an extension, and sequences
-- that belong to a table column (they move with the table), are left alone.
create or replace function _keel.adopt(cls oid, obj oid) returns void
language plpgsql set search_path = pg_catalog as $$
declare
  target name := _keel.owner_role();
  r record;
begin
  if not exists (select 1 from pg_roles where rolname = target) then
    return;
  end if;
  if exists (select 1 from pg_depend d where d.classid = cls and d.objid = obj and d.deptype = 'e') then
    return;
  end if;
  if cls = 'pg_class'::regclass then
    -- With search_path = pg_catalog, ::regclass::text is always schema-qualified.
    select c.relkind, c.oid::regclass::text as ident into r
      from pg_class c join pg_roles o on o.oid = c.relowner
     where c.oid = obj and c.relnamespace = 'public'::regnamespace and o.rolsuper
       and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
       and not (c.relkind = 'S' and exists (
         select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i')));
    if found then
      execute format('alter %s %s owner to %I',
        case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end,
        r.ident, target);
    end if;
  elsif cls = 'pg_proc'::regclass then
    select p.prokind, p.oid::regprocedure::text as ident into r
      from pg_proc p join pg_roles o on o.oid = p.proowner
     where p.oid = obj and p.pronamespace = 'public'::regnamespace and o.rolsuper;
    if found then
      execute format('alter %s %s owner to %I',
        case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.ident, target);
    end if;
  elsif cls = 'pg_type'::regclass then
    -- Enums, domains, ranges and composite types made with CREATE TYPE (not a table's row type).
    select t.typtype, t.oid::regtype::text as ident into r
      from pg_type t join pg_roles o on o.oid = t.typowner
     where t.oid = obj and t.typnamespace = 'public'::regnamespace and o.rolsuper
       and (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c'));
    if found then
      execute format('alter %s %s owner to %I', case r.typtype when 'd' then 'domain' else 'type' end, r.ident, target);
    end if;
  end if;
end
$$;

-- The public schema and everything a superuser owns in it.
create or replace function _keel.adopt_public() returns void
language plpgsql set search_path = pg_catalog as $$
declare
  target name := _keel.owner_role();
  o record;
begin
  if not exists (select 1 from pg_roles where rolname = target) then
    return;
  end if;
  if exists (select 1 from pg_namespace n join pg_roles r on r.oid = n.nspowner
              where n.nspname = 'public' and (r.rolsuper or r.rolname = 'pg_database_owner')) then
    execute format('alter schema public owner to %I', target);
  end if;
  for o in
    select 'pg_class'::regclass::oid as cls, c.oid from pg_class c where c.relnamespace = 'public'::regnamespace
    union all
    select 'pg_proc'::regclass::oid, p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all
    select 'pg_type'::regclass::oid, t.oid from pg_type t where t.typnamespace = 'public'::regnamespace
  loop
    perform _keel.adopt(o.cls, o.oid);
  end loop;
end
$$;

-- Whatever a superuser creates (or hands back to itself) in public goes to
-- the owner role right away. Commands run by other roles are left alone.
create or replace function _keel.adopt_new() returns event_trigger
language plpgsql set search_path = pg_catalog as $$
declare
  cmd record;
begin
  if not coalesce((select rolsuper from pg_roles where rolname = current_user), false) then
    return;
  end if;
  for cmd in select classid, objid from pg_event_trigger_ddl_commands() where schema_name = 'public' loop
    perform _keel.adopt(cmd.classid, cmd.objid);
  end loop;
end
$$;

drop event trigger if exists keel_owner_adopt;
create event trigger keel_owner_adopt on ddl_command_end
  execute function _keel.adopt_new();

do $$
declare
  o name := _keel.owner_role();
begin
  if not exists (select 1 from pg_roles where rolname = o) then
    raise exception 'role % does not exist (keel-migrate creates it)', o;
  end if;
  -- CREATE on the database also lets it own the publication below.
  execute format('grant connect, create, temporary on database %I to %I', current_database(), o);
  execute format('grant usage, create on schema extensions to %I', o);
  execute format('grant usage on schema auth, storage, realtime to %I', o);
  execute format('grant select, insert, update, delete, references on all tables in schema auth to %I', o);
  execute format('grant usage, select on all sequences in schema auth to %I', o);
  -- Triggers on auth.users, e.g. creating a profile row for each new user.
  execute format('grant trigger on auth.users to %I', o);
  execute format('grant select, insert, update, delete, references on storage.buckets, storage.objects to %I', o);
  execute format('grant select, insert, update, delete on realtime.messages to %I', o);
  -- What it creates in public is reachable by the API roles (row level security decides), as with Studio.
  execute format('alter default privileges for role %I in schema public grant all on tables to anon, authenticated, service_role', o);
  execute format('alter default privileges for role %I in schema public grant all on sequences to anon, authenticated, service_role', o);
  execute format('alter default privileges for role %I in schema public grant all on routines to anon, authenticated, service_role', o);
  -- `alter publication supabase_realtime add table ...` needs the publication's owner.
  execute format('alter publication supabase_realtime owner to %I', o);
end
$$;

select _keel.adopt_public();
