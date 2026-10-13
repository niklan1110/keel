-- Realtime Authorization and Broadcast from the database, compatible with
-- Supabase Realtime:
--
--   * Clients join private channels with `supabase.channel('room', { config: { private: true } })`.
--     Keel lets them in only if an RLS policy on realtime.messages allows it:
--     SELECT policies decide who may receive broadcasts and presence on a topic,
--     INSERT policies decide who may send them. realtime.topic() returns the
--     channel being checked.
--   * realtime.send() and realtime.broadcast_changes() broadcast from SQL and triggers.

create schema if not exists realtime;
alter schema realtime owner to keel_realtime_admin;
grant usage on schema realtime to anon, authenticated, service_role;

create table if not exists realtime.messages (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  extension   text not null check (extension in ('broadcast', 'presence')),
  payload     jsonb,
  event       text,
  private     boolean not null default false,
  inserted_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists messages_inserted_at_idx on realtime.messages (inserted_at);
alter table realtime.messages owner to keel_realtime_admin;
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated;
grant all on realtime.messages to service_role;

create or replace function realtime.topic() returns text
language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;

-- Committed broadcast messages are handed to keel-realtime with NOTIFY.
create or replace function realtime.notify_message() returns trigger
language plpgsql as $$
begin
  if new.extension = 'broadcast' then
    perform pg_notify('keel_realtime_messages', new.id::text);
  end if;
  return null;
end
$$;

drop trigger if exists messages_notify on realtime.messages;
create trigger messages_notify
  after insert on realtime.messages
  for each row execute function realtime.notify_message();

-- Broadcast a message to everyone subscribed to `topic`. Runs with the
-- caller's privileges, so call it from a SECURITY DEFINER trigger function
-- (or add an INSERT policy on realtime.messages). Failures are reported as
-- warnings instead of aborting the caller's transaction.
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language plpgsql as $$
begin
  begin
    perform set_config('realtime.topic', topic, true);
    insert into realtime.messages (payload, event, topic, private, extension)
    values (payload, event, topic, private, 'broadcast');
  exception when others then
    raise warning 'ErrorSendingBroadcastMessage: %', sqlerrm;
  end;
end
$$;

-- Broadcast a row change from a trigger, in the same shape as Supabase.
create or replace function realtime.broadcast_changes(
  topic_name text, event_name text, operation text, table_name text, table_schema text,
  new record, old record, level text default 'ROW'
) returns void
language plpgsql as $$
declare
  row_data jsonb;
begin
  if level = 'STATEMENT' then
    row_data := jsonb_build_object('operation', operation, 'table', table_name, 'schema', table_schema);
  else
    row_data := jsonb_build_object(
      'old_record', to_jsonb(old),
      'record', to_jsonb(new),
      'operation', operation, 'table', table_name, 'schema', table_schema
    );
  end if;
  perform realtime.send(row_data, event_name, topic_name);
end
$$;

alter function realtime.topic() owner to keel_realtime_admin;
alter function realtime.notify_message() owner to keel_realtime_admin;
alter function realtime.send(jsonb, text, text, boolean) owner to keel_realtime_admin;
alter function realtime.broadcast_changes(text, text, text, text, text, record, record, text) owner to keel_realtime_admin;
grant execute on function realtime.topic(), realtime.send(jsonb, text, text, boolean),
  realtime.broadcast_changes(text, text, text, text, text, record, record, text) to anon, authenticated, service_role;
