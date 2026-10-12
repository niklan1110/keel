-- Control-plane schema. Runs as the superuser against the `keel` database. Idempotent.

create schema if not exists keel;

create table if not exists keel.projects (
  name        text primary key,
  db_name     text not null unique,
  jwt_secret  text not null,
  anon_key    text not null,
  service_key text not null,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists keel.saved_queries (
  id         uuid primary key default gen_random_uuid(),
  project    text not null references keel.projects (name) on delete cascade on update cascade,
  name       text not null,
  sql        text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists saved_queries_project_idx on keel.saved_queries (project);

create table if not exists keel.backups (
  id         uuid primary key default gen_random_uuid(),
  project    text not null,
  file       text not null,
  size_bytes bigint not null default 0,
  kind       text not null default 'manual',
  status     text not null default 'ok',
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists backups_project_idx on keel.backups (project, created_at desc);

-- Full backups: every database and the uploaded files in one encrypted file
-- (backups/full/keel-<time>.tar.age), and whether it was copied off the machine.
create table if not exists keel.backup_sets (
  id           uuid primary key default gen_random_uuid(),
  file         text not null,
  size_bytes   bigint not null default 0,
  kind         text not null default 'manual',
  status       text not null default 'running',
  error        text,
  remote       text not null default 'none',
  remote_error text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists backup_sets_created_idx on keel.backup_sets (created_at desc);

-- Backup settings changed in Studio (schedule, retention, off-machine target).
-- The target's secret key is sealed with a key derived from KEEL_SECRET. No
-- service role is granted access: only the superuser (Studio) reads it.
create table if not exists keel.backup_settings (
  id         boolean primary key default true check (id),
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Edge functions. Source files are stored here; keel-functions writes them to
-- disk and runs them with Deno. Paths in `files` are relative to the
-- functions directory, e.g. {"hello/index.ts": "...", "_shared/cors.ts": "..."}.
create table if not exists keel.functions (
  project     text not null references keel.projects (name) on delete cascade on update cascade,
  name        text not null,
  entrypoint  text not null,
  files       jsonb not null default '{}'::jsonb,
  verify_jwt  boolean not null default true,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (project, name)
);

-- Environment variables handed to a project's functions (Deno.env.get).
create table if not exists keel.function_secrets (
  project    text not null references keel.projects (name) on delete cascade on update cascade,
  name       text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  primary key (project, name)
);

create or replace function keel.notify_functions() returns trigger
language plpgsql as $$
begin
  perform pg_notify('keel_functions', coalesce(new.project, old.project));
  return null;
end
$$;

drop trigger if exists functions_notify on keel.functions;
create trigger functions_notify
  after insert or update or delete on keel.functions
  for each row execute function keel.notify_functions();
drop trigger if exists function_secrets_notify on keel.function_secrets;
create trigger function_secrets_notify
  after insert or update or delete on keel.function_secrets
  for each row execute function keel.notify_functions();

-- Services cache the project registry and reload when it changes.
create or replace function keel.notify_projects() returns trigger
language plpgsql as $$
begin
  perform pg_notify('keel_projects', coalesce(new.name, old.name));
  return null;
end
$$;

drop trigger if exists projects_notify on keel.projects;
create trigger projects_notify
  after insert or update or delete on keel.projects
  for each row execute function keel.notify_projects();

create or replace function keel.notify_projects_by_key() returns trigger
language plpgsql as $$
begin
  perform pg_notify('keel_projects', coalesce(new.project, old.project));
  return null;
end
$$;

-- Signing keys for each project's JWTs (API keys, user access tokens).
-- Several can be active while keys are rolled: new tokens are signed with
-- the newest key and carry its id (`kid`), and older keys keep verifying
-- until `expires_at`. Revoking a key deletes its row. keel.projects.jwt_secret
-- stays the project's internal secret (sealing MFA secrets, deriving
-- refresh tokens and one-time codes) and was its first signing key.
create table if not exists keel.project_jwt_keys (
  project    text not null references keel.projects (name) on delete cascade on update cascade,
  kid        text not null,
  secret     text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (project, kid)
);

-- Projects created before keys had ids sign with their jwt_secret, as "legacy".
insert into keel.project_jwt_keys (project, kid, secret, created_at)
select p.name, 'legacy', p.jwt_secret, p.created_at
  from keel.projects p
 where not exists (select 1 from keel.project_jwt_keys k where k.project = p.name);

drop trigger if exists project_jwt_keys_notify on keel.project_jwt_keys;
create trigger project_jwt_keys_notify
  after insert or update or delete on keel.project_jwt_keys
  for each row execute function keel.notify_projects_by_key();

-- Who rolled or revoked which key, and when.
create table if not exists keel.project_key_events (
  id         uuid primary key default gen_random_uuid(),
  project    text not null references keel.projects (name) on delete cascade on update cascade,
  action     text not null,
  kid        text,
  actor      text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists project_key_events_project_idx on keel.project_key_events (project, created_at desc);

-- Server-wide settings changed in Studio. They win over the same values in
-- .env, and every service picks them up through the keel_projects channel.
create table if not exists keel.server_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create or replace function keel.notify_server_settings() returns trigger
language plpgsql as $$
begin
  perform pg_notify('keel_projects', '');
  return null;
end
$$;

drop trigger if exists server_settings_notify on keel.server_settings;
create trigger server_settings_notify
  after insert or update or delete on keel.server_settings
  for each statement execute function keel.notify_server_settings();

-- Password of each project's owner role (<database>_owner), which Studio shows
-- in Connect. Only the superuser (Studio, keel-migrate) reads it.
create table if not exists keel.project_owners (
  project    text primary key references keel.projects (name) on delete cascade on update cascade,
  password   text not null,
  created_at timestamptz not null default now()
);

-- What each of Keel's roles may see of keel.projects (only Studio and the
-- superuser read the table itself). Every service needs each project's name,
-- database and JWT secret; beyond that:
--   authenticator (gateway, rest)   settings.rest
--   keel_auth_admin                 all settings (SMTP, OAuth, SMS)
--   keel_realtime_admin             settings.realtime
--   keel_functions_admin            the anon and service role keys, which it
--                                   hands to function code (SUPABASE_*_KEY)
--   keel_egress_admin               only the name and database (no JWT secret)
-- A project owner role (<database>_owner) sees only its own project's name.
create or replace view keel.visible_projects with (security_barrier) as
select p.name,
       p.db_name,
       case when s.service then p.jwt_secret end as jwt_secret,
       case when current_user = 'keel_functions_admin' then p.anon_key end as anon_key,
       case when current_user = 'keel_functions_admin' then p.service_key end as service_key,
       case current_user
         when 'keel_auth_admin' then p.settings
         when 'authenticator' then jsonb_strip_nulls(jsonb_build_object('rest', p.settings -> 'rest'))
         when 'keel_realtime_admin' then jsonb_strip_nulls(jsonb_build_object('realtime', p.settings -> 'realtime'))
         else '{}'::jsonb
       end as settings,
       p.created_at
  from keel.projects p,
       lateral (select current_user in ('authenticator', 'keel_auth_admin', 'keel_storage_admin', 'keel_realtime_admin', 'keel_functions_admin') as service) s
 where s.service or current_user = 'keel_egress_admin' or current_user = p.db_name || '_owner';

revoke all on database keel from public;
grant connect on database keel to authenticator, keel_auth_admin, keel_storage_admin, keel_realtime_admin, keel_functions_admin, keel_egress_admin, keel_project_owners;
revoke all on schema keel from public;
grant usage on schema keel to authenticator, keel_auth_admin, keel_storage_admin, keel_realtime_admin, keel_functions_admin, keel_egress_admin, keel_project_owners;
-- Earlier versions let every service role read keel.projects, service keys included.
revoke all on keel.projects from authenticator, keel_auth_admin, keel_storage_admin, keel_realtime_admin, keel_functions_admin, keel_egress_admin;
grant select on keel.visible_projects to authenticator, keel_auth_admin, keel_storage_admin, keel_realtime_admin, keel_functions_admin, keel_egress_admin, keel_project_owners;
grant select on keel.server_settings to authenticator, keel_auth_admin, keel_storage_admin, keel_realtime_admin, keel_functions_admin, keel_egress_admin;
grant select on keel.functions, keel.function_secrets to keel_functions_admin;
grant select on keel.project_jwt_keys to authenticator, keel_auth_admin, keel_storage_admin, keel_realtime_admin, keel_functions_admin;

-- Project owners deploy functions and set secrets (keel fn deploy, keel
-- secrets with KEEL_DB_URL) for their own project only.
grant select, insert, update, delete on keel.functions, keel.function_secrets to keel_project_owners;
alter table keel.functions enable row level security;
alter table keel.function_secrets enable row level security;
drop policy if exists service_reads on keel.functions;
create policy service_reads on keel.functions for select to keel_functions_admin using (true);
drop policy if exists service_reads on keel.function_secrets;
create policy service_reads on keel.function_secrets for select to keel_functions_admin using (true);
drop policy if exists own_project on keel.functions;
create policy own_project on keel.functions for all to keel_project_owners
  using (project in (select name from keel.visible_projects)) with check (project in (select name from keel.visible_projects));
drop policy if exists own_project on keel.function_secrets;
create policy own_project on keel.function_secrets for all to keel_project_owners
  using (project in (select name from keel.visible_projects)) with check (project in (select name from keel.visible_projects));

-- Studio accounts. Every account is a full Studio admin. The account named
-- by KEEL_DASHBOARD_USERNAME is the owner: keel-studio creates it from the
-- .env password on first start and resets its password whenever the .env
-- password changes (the recovery path). Passwords are scrypt hashes.
create table if not exists keel.studio_users (
  id             uuid primary key default gen_random_uuid(),
  username       text not null,
  password_hash  text not null,
  is_owner       boolean not null default false,
  totp_secret    text,
  totp_last_step bigint,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_login_at  timestamptz
);
create unique index if not exists studio_users_username_idx on keel.studio_users (lower(username));

-- Signed-in Studio sessions. Tokens name a session here, so signing out (or
-- a password change) ends it on the server, not only in the browser.
create table if not exists keel.studio_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references keel.studio_users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           text,
  user_agent   text,
  from_internet boolean not null default false
);
create index if not exists studio_sessions_user_idx on keel.studio_sessions (user_id);

create table if not exists keel.studio_state (
  key   text primary key,
  value text not null
);
