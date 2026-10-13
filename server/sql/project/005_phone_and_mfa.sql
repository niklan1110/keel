-- Phone sign-in and multi-factor authentication (GoTrue-compatible names).

alter table auth.users add column if not exists phone_change text default '';
alter table auth.users add column if not exists phone_change_sent_at timestamptz;

create table if not exists auth.mfa_factors (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  friendly_name      text,
  factor_type        text not null check (factor_type in ('totp', 'phone')),
  status             text not null default 'unverified' check (status in ('unverified', 'verified')),
  secret             text,
  phone              text,
  -- Last TOTP time step accepted, so a code can't be replayed within its window.
  last_totp_step     bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_challenged_at timestamptz
);
create index if not exists mfa_factors_user_id_idx on auth.mfa_factors (user_id);
create unique index if not exists mfa_factors_user_friendly_name_key
  on auth.mfa_factors (user_id, friendly_name) where trim(friendly_name) <> '';
create unique index if not exists mfa_factors_user_phone_key
  on auth.mfa_factors (user_id, phone) where phone is not null;

create table if not exists auth.mfa_challenges (
  id          uuid primary key default gen_random_uuid(),
  factor_id   uuid not null references auth.mfa_factors (id) on delete cascade,
  created_at  timestamptz not null default now(),
  verified_at timestamptz,
  ip_address  inet,
  -- SHA-256 of the code sent by SMS for phone factors.
  otp_code    text
);
create index if not exists mfa_challenges_factor_idx on auth.mfa_challenges (factor_id, created_at desc);

alter table auth.mfa_factors owner to keel_auth_admin;
alter table auth.mfa_challenges owner to keel_auth_admin;
