-- Auth schema. Table and column names follow GoTrue (Supabase Auth) so that
-- existing triggers such as `on insert to auth.users` and data exported from
-- Supabase keep working.

create schema if not exists auth;
alter schema auth owner to keel_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id                 uuid,
  id                          uuid primary key default gen_random_uuid(),
  aud                         varchar(255) default 'authenticated',
  role                        varchar(255) default 'authenticated',
  email                       varchar(255),
  encrypted_password          varchar(255),
  email_confirmed_at          timestamptz,
  invited_at                  timestamptz,
  confirmation_token          varchar(255),
  confirmation_sent_at        timestamptz,
  recovery_token              varchar(255),
  recovery_sent_at            timestamptz,
  email_change_token_new      varchar(255),
  email_change                varchar(255),
  email_change_sent_at        timestamptz,
  last_sign_in_at             timestamptz,
  raw_app_meta_data           jsonb not null default '{}'::jsonb,
  raw_user_meta_data          jsonb not null default '{}'::jsonb,
  is_super_admin              boolean,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  phone                       text default null,
  phone_confirmed_at          timestamptz,
  confirmed_at                timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  banned_until                timestamptz,
  deleted_at                  timestamptz,
  is_anonymous                boolean not null default false
);
create unique index if not exists users_email_key on auth.users (lower(email)) where email is not null;
create unique index if not exists users_phone_key on auth.users (phone) where phone is not null;
create index if not exists users_created_at_idx on auth.users (created_at desc);

create table if not exists auth.identities (
  id              uuid primary key default gen_random_uuid(),
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null default '{}'::jsonb,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  email           text generated always as (lower(identity_data ->> 'email')) stored,
  unique (provider_id, provider)
);
create index if not exists identities_user_id_idx on auth.identities (user_id);

create table if not exists auth.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  refreshed_at timestamptz,
  user_agent   text,
  ip           inet,
  aal          text not null default 'aal1',
  amr          jsonb not null default '[]'::jsonb,
  not_after    timestamptz
);
create index if not exists sessions_user_id_idx on auth.sessions (user_id);

-- Refresh tokens are stored as SHA-256 hashes, never in plain text.
create table if not exists auth.refresh_tokens (
  id         bigserial primary key,
  token      varchar(255) not null unique,
  user_id    uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null references auth.sessions (id) on delete cascade,
  parent     varchar(255),
  revoked    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists refresh_tokens_session_idx on auth.refresh_tokens (session_id);
create index if not exists refresh_tokens_parent_idx on auth.refresh_tokens (parent);

-- Email confirmation, magic link, recovery, invite and email-change tokens (hashed).
create table if not exists auth.one_time_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  token_type text not null,
  token_hash text not null,
  relates_to text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token_type)
);
create index if not exists one_time_tokens_hash_idx on auth.one_time_tokens (token_hash);

-- PKCE and OAuth state.
create table if not exists auth.flow_state (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid references auth.users (id) on delete cascade,
  auth_code              text,
  code_challenge_method  text,
  code_challenge         text,
  provider_type          text not null,
  provider_access_token  text,
  provider_refresh_token text,
  redirect_to            text,
  authentication_method  text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  auth_code_issued_at    timestamptz
);
create index if not exists flow_state_auth_code_idx on auth.flow_state (auth_code);

alter table auth.users owner to keel_auth_admin;
alter table auth.identities owner to keel_auth_admin;
alter table auth.sessions owner to keel_auth_admin;
alter table auth.refresh_tokens owner to keel_auth_admin;
alter sequence auth.refresh_tokens_id_seq owner to keel_auth_admin;
alter table auth.one_time_tokens owner to keel_auth_admin;
alter table auth.flow_state owner to keel_auth_admin;

-- Helpers for RLS policies, identical to Supabase's.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.role', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    ),
    ''
  )::text
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.email', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    ),
    ''
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

alter function auth.uid() owner to keel_auth_admin;
alter function auth.role() owner to keel_auth_admin;
alter function auth.email() owner to keel_auth_admin;
alter function auth.jwt() owner to keel_auth_admin;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to public;
