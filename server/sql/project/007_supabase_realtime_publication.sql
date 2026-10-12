-- Realtime streams the tables in the `supabase_realtime` publication, the same
-- name Supabase uses, so `alter publication supabase_realtime add table ...`
-- from Supabase guides and migrations works as written. Projects created
-- before this used `keel_realtime`; it is renamed (or merged) here.
do $$
declare
  t record;
begin
  if exists (select 1 from pg_publication where pubname = 'keel_realtime') then
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      alter publication keel_realtime rename to supabase_realtime;
    else
      for t in
        select schemaname, tablename from pg_publication_tables p
        where p.pubname = 'keel_realtime'
          and not exists (select 1 from pg_publication_tables s
                          where s.pubname = 'supabase_realtime' and s.schemaname = p.schemaname and s.tablename = p.tablename)
      loop
        execute format('alter publication supabase_realtime add table %I.%I', t.schemaname, t.tablename);
      end loop;
      drop publication keel_realtime;
    end if;
  elsif not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
