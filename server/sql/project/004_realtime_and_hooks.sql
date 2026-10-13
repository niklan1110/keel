-- Realtime: tables added to this publication stream their changes to
-- subscribed clients (toggle per table in Studio, or run
-- `alter publication supabase_realtime add table public.my_table`; renamed in 007).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'keel_realtime') then
    create publication keel_realtime;
  end if;
end
$$;

-- Tell PostgREST to reload its schema cache whenever the schema changes, so
-- new tables and columns show up in the API without a restart.
create or replace function _keel.notify_pgrst() returns event_trigger
language plpgsql as $$
begin
  notify pgrst, 'reload schema';
end
$$;

drop event trigger if exists keel_pgrst_ddl_watch;
create event trigger keel_pgrst_ddl_watch on ddl_command_end
  execute function _keel.notify_pgrst();

drop event trigger if exists keel_pgrst_drop_watch;
create event trigger keel_pgrst_drop_watch on sql_drop
  execute function _keel.notify_pgrst();

-- Safe by default: new tables in `public` get row level security switched
-- on, so nothing is readable through the API until a policy allows it.
-- Disable per project with: alter database <db> set keel.auto_rls = 'off';
create or replace function _keel.auto_enable_rls() returns event_trigger
language plpgsql as $$
declare
  cmd record;
begin
  if coalesce(nullif(current_setting('keel.auto_rls', true), ''), 'on') = 'off' then
    return;
  end if;
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where object_type = 'table' and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', cmd.object_identity);
  end loop;
end
$$;

drop event trigger if exists keel_auto_rls;
create event trigger keel_auto_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function _keel.auto_enable_rls();
