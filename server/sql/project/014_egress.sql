-- keel-egress sends the requests queued by net.http_* and database webhooks
-- (013_cron_and_net.sql). It logs in as keel_egress_admin, which may only
-- take requests off the queue and write their responses: no other table of
-- the project, and no superuser.

-- Requests taken off the queue and not answered yet. A request still here
-- when keel-egress starts was cut off by a restart: it gets an error
-- response instead of disappearing.
create table if not exists net._keel_sending (
  id bigint primary key,
  taken_at timestamptz not null default now()
);
revoke all on net._keel_sending from public;

grant usage on schema net to keel_egress_admin;
-- UPDATE on one column only for FOR UPDATE SKIP LOCKED.
grant select, delete, update (id) on net.http_request_queue to keel_egress_admin;
grant select, insert, delete on net._http_response to keel_egress_admin;
grant select, insert, delete on net._keel_sending to keel_egress_admin;

-- Whether the queue is full (net._enqueue refuses more).
create or replace function net._queue_full() returns boolean
language sql stable set search_path = pg_catalog as $$
  select (select count(*) from (select 1 from net.http_request_queue limit 10000) q) >= 10000
$$;
revoke all on function net._queue_full() from public;

do $$
begin
  execute format('grant execute on function net._queue_full() to %I', _keel.owner_role());
end
$$;

-- As in 013, except that a full queue doesn't fail the change that fired the
-- webhook (an insert through the API, say): the request is skipped, a
-- warning raised, and the hook recorded with no request id.
create or replace function supabase_functions.http_request() returns trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare
  request_id bigint;
  payload jsonb;
  url text := tg_argv[0]::text;
  method text := tg_argv[1]::text;
  headers jsonb default '{}'::jsonb;
  params jsonb default '{}'::jsonb;
  timeout_ms integer default 1000;
begin
  if url is null or url = 'null' then
    raise exception 'url argument is missing';
  end if;
  if method is null or method = 'null' then
    raise exception 'method argument is missing';
  end if;
  if tg_argv[2] is null or tg_argv[2] = 'null' then
    headers := '{"Content-Type": "application/json"}'::jsonb;
  else
    headers := tg_argv[2]::jsonb;
  end if;
  if tg_argv[3] is null or tg_argv[3] = 'null' then
    params := '{}'::jsonb;
  else
    params := tg_argv[3]::jsonb;
  end if;
  if tg_argv[4] is null or tg_argv[4] = 'null' then
    timeout_ms := 1000;
  else
    timeout_ms := tg_argv[4]::integer;
  end if;
  if method not in ('GET', 'POST') then
    raise exception 'method argument % is invalid', method;
  end if;
  if net._queue_full() then
    raise warning 'webhook % skipped: 10000 requests are already waiting to be sent', tg_name;
  elsif method = 'GET' then
    request_id := net.http_get(url, params, headers, timeout_ms);
  else
    payload := jsonb_build_object('old_record', old, 'record', new, 'type', tg_op, 'table', tg_table_name, 'schema', tg_table_schema);
    request_id := net.http_post(url, payload, params, headers, timeout_ms);
  end if;
  insert into supabase_functions.hooks (hook_table_id, hook_name, request_id) values (tg_relid, tg_name, request_id);
  return new;
end
$$;
