-- Views follow row level security too. A view normally reads its tables with
-- its owner's rights (the superuser, for views made in Studio or with psql),
-- so a view in `public` would skip the tables' policies and show the API
-- every row. New views in `public` (CREATE VIEW, CREATE OR REPLACE VIEW) get
-- security_invoker, so they read as the caller and the policies apply.
--
-- A view created with an explicit `with (security_invoker = false)` keeps
-- its owner's rights. Materialized views can't run as the caller: they store
-- their rows, and anyone allowed to select from one sees all of them.
--
-- The same switch as automatic RLS turns this off (the importer does, so
-- imported views keep the setting they had in the source):
--   alter database <db> set keel.auto_rls = 'off';
-- Views that existed before this migration are left as they are.
create or replace function _keel.auto_view_security_invoker() returns event_trigger
language plpgsql as $$
declare
  cmd record;
begin
  if coalesce(nullif(current_setting('keel.auto_rls', true), ''), 'on') = 'off' then
    return;
  end if;
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where object_type = 'view' and schema_name = 'public'
  loop
    -- Respect security_invoker when the statement set it (either way).
    -- CREATE OR REPLACE VIEW without it resets the view's options, so it's set again.
    if exists (
      select 1 from pg_class c, unnest(c.reloptions) o
      where c.oid = cmd.objid and o like 'security_invoker=%'
    ) then
      continue;
    end if;
    execute format('alter view %s set (security_invoker = true)', cmd.object_identity);
  end loop;
end
$$;

drop event trigger if exists keel_auto_view_security_invoker;
create event trigger keel_auto_view_security_invoker on ddl_command_end
  when tag in ('CREATE VIEW')
  execute function _keel.auto_view_security_invoker();
