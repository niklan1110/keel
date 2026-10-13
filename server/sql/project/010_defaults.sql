-- Project defaults: a saved copy of the rows in your tables, and a way back to it.
--
--   select _keel_defaults.save();     -- the current rows become the defaults
--   select _keel_defaults.restore();  -- every table goes back to them
--
-- Studio uses these (Backups > Defaults). They cover your own tables, not
-- Keel's (users, files and their records, realtime settings) or extensions'.
-- Restoring empties tables that weren't there when the defaults were saved.
--
-- The schema is left out of Studio's backups, so restoring a backup keeps
-- the defaults. Keep everything for this feature in this schema: pg_restore
-- --clean drops whole schemas, which fails while they hold objects that an
-- older dump doesn't know about.

create schema if not exists _keel_defaults;
revoke all on schema _keel_defaults from public;

create table if not exists _keel_defaults.info (
  id boolean primary key default true check (id),
  saved_at timestamptz not null
);

-- Every table that was saved, with how many rows it had (0 counts too: it is emptied on restore).
create table if not exists _keel_defaults.tables (
  table_schema text not null,
  table_name text not null,
  row_count bigint not null,
  primary key (table_schema, table_name)
);

create table if not exists _keel_defaults.rows (
  id bigint generated always as identity primary key,
  table_schema text not null,
  table_name text not null,
  data jsonb not null
);
create index if not exists rows_table_idx on _keel_defaults.rows (table_schema, table_name, id);

-- Your tables: ordinary and partitioned tables (not partitions, temporary
-- tables or tables that belong to an extension) outside Keel's own schemas.
create or replace function _keel_defaults.user_tables()
returns table (table_schema text, table_name text, partitioned boolean)
language sql stable set search_path = pg_catalog as $$
  select n.nspname::text, c.relname::text, c.relkind = 'p'
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and not c.relispartition
     and c.relpersistence <> 't'
     and n.nspname not like 'pg\_%'
     and n.nspname not in ('information_schema', '_keel', '_keel_defaults', 'extensions', 'auth', 'storage', 'realtime',
                           'graphql', 'graphql_public', 'supabase_functions', 'supabase_migrations', 'vault',
                           'pgsodium', 'pgsodium_masks', 'net', 'cron', 'pgbouncer', 'topology', 'tiger', 'tiger_data')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
   order by 1, 2
$$;

create or replace function _keel_defaults.save() returns jsonb
language plpgsql set search_path = pg_catalog as $$
declare
  t record;
  n bigint;
  total bigint := 0;
  tables int := 0;
begin
  -- All tables from one snapshot when the caller runs this in a repeatable
  -- read transaction (Studio does).
  truncate _keel_defaults.rows, _keel_defaults.tables restart identity;
  for t in select * from _keel_defaults.user_tables() loop
    -- ONLY: an inheritance parent's own rows; its children are saved as tables of their own.
    execute format(
      'insert into _keel_defaults.rows (table_schema, table_name, data) select %L, %L, to_jsonb(x) from %s %I.%I x',
      t.table_schema, t.table_name, case when t.partitioned then '' else 'only' end, t.table_schema, t.table_name);
    get diagnostics n = row_count;
    insert into _keel_defaults.tables values (t.table_schema, t.table_name, n);
    total := total + n;
    tables := tables + 1;
  end loop;
  insert into _keel_defaults.info (saved_at) values (now())
    on conflict (id) do update set saved_at = excluded.saved_at;
  return jsonb_build_object('savedAt', now(), 'tables', tables, 'rows', total);
end
$$;

create or replace function _keel_defaults.restore() returns jsonb
language plpgsql set search_path = pg_catalog as $$
declare
  t record;
  fk record;
  s record;
  n bigint;
  total bigint := 0;
  cols text;
  xcols text;
  targets text;
  bad bigint;
  emptied text[] := '{}';
  missing text[] := '{}';
  saved timestamptz;
begin
  select saved_at into saved from _keel_defaults.info;
  if saved is null then
    raise exception 'No defaults saved for this project yet' using errcode = 'P0002';
  end if;

  -- Empty every table at once (so foreign keys between them don't get in
  -- the way) and restart their id counters.
  select string_agg(format('%I.%I', u.table_schema, u.table_name), ', ') into targets from _keel_defaults.user_tables() u;
  if targets is not null then
    execute 'truncate ' || targets || ' restart identity';
  end if;

  select coalesce(array_agg(format('%s.%s', u.table_schema, u.table_name)), '{}') into emptied
    from _keel_defaults.user_tables() u
   where not exists (select 1 from _keel_defaults.tables d where d.table_schema = u.table_schema and d.table_name = u.table_name);

  -- Load the saved rows as they were, like pg_restore does: without firing
  -- triggers or checking foreign keys row by row. Keys are checked below.
  set local session_replication_role = replica;
  for t in
    select d.* from _keel_defaults.tables d where d.row_count > 0 order by d.table_schema, d.table_name
  loop
    if to_regclass(format('%I.%I', t.table_schema, t.table_name)) is null then
      missing := missing || format('%s.%s', t.table_schema, t.table_name);
      continue;
    end if;
    -- Columns the table has now and the saved rows have too; new columns get their defaults.
    select string_agg(format('%I', a.attname), ', ' order by a.attnum),
           string_agg(format('x.%I', a.attname), ', ' order by a.attnum)
      into cols, xcols
      from pg_attribute a
     where a.attrelid = format('%I.%I', t.table_schema, t.table_name)::regclass
       and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and exists (select 1 from _keel_defaults.rows r
                    where r.table_schema = t.table_schema and r.table_name = t.table_name and r.data ? a.attname);
    if cols is null then
      continue;
    end if;
    execute format(
      'insert into %I.%I (%s) overriding system value select %s from _keel_defaults.rows r, '
      'jsonb_populate_record(null::%I.%I, r.data) x where r.table_schema = %L and r.table_name = %L order by r.id',
      t.table_schema, t.table_name, cols, xcols, t.table_schema, t.table_name, t.table_schema, t.table_name);
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  set local session_replication_role = origin;

  -- Foreign keys: the saved rows may point at rows that are gone since, such
  -- as users deleted after the defaults were saved.
  for fk in
    select c.conname, c.conrelid::regclass as child, c.confrelid::regclass as parent,
           c.conrelid, c.confrelid, c.conkey, c.confkey
      from pg_constraint c
      join pg_class rel on rel.oid = c.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where c.contype = 'f' and c.conparentid = 0
       and exists (select 1 from _keel_defaults.user_tables() u where u.table_schema = ns.nspname and u.table_name = rel.relname)
  loop
    execute format(
      'select count(*) from %s c where %s and not exists (select 1 from %s p where %s)',
      fk.child,
      (select string_agg(format('c.%I is not null', a.attname), ' and ')
         from unnest(fk.conkey) k join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = k),
      fk.parent,
      (select string_agg(format('p.%I = c.%I', pa.attname, ca.attname), ' and ')
         from unnest(fk.conkey, fk.confkey) as k(ck, pk)
         join pg_attribute ca on ca.attrelid = fk.conrelid and ca.attnum = k.ck
         join pg_attribute pa on pa.attrelid = fk.confrelid and pa.attnum = k.pk))
      into bad;
    if bad > 0 then
      raise exception '% in % % at rows of % that no longer exist',
        case when bad = 1 then '1 saved row' else bad || ' saved rows' end, fk.child,
        case when bad = 1 then 'points' else 'point' end, fk.parent
        using errcode = '23503',
              hint = 'Bring those rows back, or save the defaults again without them.';
    end if;
  end loop;

  -- Id counters continue after the restored rows.
  for s in
    select d.refobjid::regclass as tbl, a.attname, d.objid::regclass as seq
      from pg_depend d
      join pg_class sc on sc.oid = d.objid and sc.relkind = 'S'
      join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
      join pg_class rel on rel.oid = d.refobjid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
       and exists (select 1 from _keel_defaults.user_tables() u where u.table_schema = ns.nspname and u.table_name = rel.relname)
  loop
    execute format('select max(%I)::bigint from %s', s.attname, s.tbl) into n;
    if n is not null and n >= (select seqmin from pg_sequence where seqrelid = s.seq) then
      perform setval(s.seq, n);
    end if;
  end loop;

  return jsonb_build_object('savedAt', saved, 'rows', total, 'emptied', to_jsonb(emptied), 'missing', to_jsonb(missing));
end
$$;
