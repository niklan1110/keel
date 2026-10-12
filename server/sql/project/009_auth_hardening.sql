-- keel-auth hardening.

-- When the account's current email address was proven to belong to its
-- owner: a link or code sent to it was used, Google or GitHub reported it as
-- verified, or an admin set it with email_confirm. email_confirmed_at alone
-- doesn't say that: without a mail server, sign-ups are confirmed
-- automatically. When someone first proves an address that wasn't proven,
-- keel-auth removes the account's password, phone number, other identities
-- and sessions, so whoever registered the address beforehand can't keep access.
alter table auth.users add column if not exists email_proven_at timestamptz;

-- Accounts from before this column existed, and accounts that arrive later
-- with their history (an import from Supabase, a restore): when a
-- confirmation or invite was sent before the address was confirmed, a link
-- confirmed it. Automatic confirmation never sends one. keel-auth itself
-- never inserts users with these fields set, so this only fires for copies.
create or replace function auth.keel_email_proof_from_history() returns trigger
language plpgsql as $$
begin
  if new.email_proven_at is null and new.email is not null and new.email_confirmed_at is not null and (
       new.invited_at <= new.email_confirmed_at
       or (coalesce(new.raw_app_meta_data ->> 'provider', 'email') = 'email' and new.confirmation_sent_at <= new.email_confirmed_at)
     ) then
    new.email_proven_at := new.email_confirmed_at;
  end if;
  return new;
end
$$;
alter function auth.keel_email_proof_from_history() owner to keel_auth_admin;

drop trigger if exists keel_email_proof_from_history on auth.users;
create trigger keel_email_proof_from_history before insert on auth.users
  for each row execute function auth.keel_email_proof_from_history();

update auth.users
   set email_proven_at = email_confirmed_at
 where email_proven_at is null and email is not null and email_confirmed_at is not null and (
       invited_at <= email_confirmed_at
       or (coalesce(raw_app_meta_data ->> 'provider', 'email') = 'email' and confirmation_sent_at <= email_confirmed_at)
     );

-- keel-auth deletes PKCE/OAuth flow state older than a day.
create index if not exists flow_state_created_at_idx on auth.flow_state (created_at);
