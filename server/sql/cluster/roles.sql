-- Cluster-wide roles shared by every Keel project database.
-- Runs as the superuser against the `postgres` database. Idempotent.
-- Login passwords are applied separately by the migrator (from POSTGRES_PASSWORD).

do $$
begin
  -- API roles. PostgREST, storage and realtime switch into these per request,
  -- based on the `role` claim of the caller's JWT.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;

  -- PostgREST connects as this role and SET ROLEs into the API roles.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;

  -- Service roles. Each owns the schema of the service that uses it.
  if not exists (select 1 from pg_roles where rolname = 'keel_auth_admin') then
    create role keel_auth_admin login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'keel_storage_admin') then
    create role keel_storage_admin login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'keel_realtime_admin') then
    create role keel_realtime_admin login noinherit replication;
  end if;
  -- Edge functions only read deployed code and secrets from the control database.
  if not exists (select 1 from pg_roles where rolname = 'keel_functions_admin') then
    create role keel_functions_admin login noinherit;
  end if;
  -- Sends the HTTP requests queued in project databases (net.http_*, database
  -- webhooks). Rights only on those queues, granted per project database.
  if not exists (select 1 from pg_roles where rolname = 'keel_egress_admin') then
    create role keel_egress_admin login noinherit;
  end if;
  -- Every project's owner role (<database>_owner) is a member: it lets them
  -- deploy edge functions and set secrets for their own project.
  if not exists (select 1 from pg_roles where rolname = 'keel_project_owners') then
    create role keel_project_owners nologin noinherit;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to keel_storage_admin;
grant anon, authenticated, service_role to keel_realtime_admin;

-- Keep runaway API queries in check, like Supabase does.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';

-- keel-egress waits on nothing for long: a project whose queue is locked is skipped.
alter role keel_egress_admin set lock_timeout = '5s';
alter role keel_egress_admin set statement_timeout = '30s';
