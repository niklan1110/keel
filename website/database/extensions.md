# Extensions

Postgres extensions add data types, functions and index types to a database. Keel's database container, `keel-db`, runs the `keel-postgres` image: the official `postgres:17-alpine` image plus [pgvector](https://github.com/pgvector/pgvector) and [PostGIS](https://postgis.net). So besides every extension that ships with Postgres itself, you get vector similarity search and geographic queries, the two extensions apps built on Supabase use most.

Like on Supabase, extensions go in the `extensions` schema. That schema is on every role's search path, so you call their functions and use their types without a prefix, and their tables and functions stay out of your REST API.

```sql
create extension vector with schema extensions;
```

Each project has its own database, so enable an extension in every project that uses it.

## Who can enable what

| Extension | Who can create it |
|---|---|
| `pgcrypto`, `uuid-ossp` | Already installed in every project. |
| `vector` (pgvector), `pg_trgm`, `citext`, `hstore`, `ltree`, `unaccent`, `btree_gin`, `btree_gist`, `fuzzystrmatch` and other trusted extensions | The project's owner role (`my_app_owner`, the role migrations use) and the superuser. |
| `postgis`, `postgis_topology` and other untrusted extensions | Only the `postgres` superuser: Studio's [SQL editor](/studio/sql-editor) or `./keel psql`. |

A migration that says `create extension if not exists postgis with schema extensions;` runs fine as the owner role once PostGIS is enabled: the extension already exists, so there is nothing to create. Enable PostGIS once in the SQL editor, then run your migrations as usual.

::: details Why PostGIS needs the superuser
Creating an extension runs its install script as a superuser. pgvector's script only creates its own types, functions and index methods, so Keel marks it trusted and the owner role can install it, as on Supabase. PostGIS' script also runs queries while it installs, so letting a non-superuser start it would be a way to run code as the superuser. Keel leaves it to the superuser.
:::

## Vector search with pgvector

Store embeddings from any model in a `vector` column and find the nearest ones with an index. The SQL is the same as in Supabase's guides.

```sql
create extension if not exists vector with schema extensions;

create table documents (
  id bigint generated always as identity primary key,
  content text not null,
  embedding vector(1536) not null       -- the size your model produces
);

-- An HNSW index for cosine distance (<=>). Use vector_l2_ops for <-> and vector_ip_ops for <#>.
create index on documents using hnsw (embedding vector_cosine_ops);

alter table documents enable row level security;
create policy "documents are readable" on documents for select to anon, authenticated using (true);

create function match_documents(query_embedding vector(1536), match_count int)
returns table (id bigint, content text, similarity float)
language sql stable as $$
  select id, content, 1 - (embedding <=> query_embedding) as similarity
    from documents
   order by embedding <=> query_embedding
   limit match_count
$$;
```

Insert embeddings as arrays of numbers and search through [RPC](/database/functions):

```js
await supabase.from('documents').insert({ content: 'Keel runs on a NAS', embedding })

const { data } = await supabase.rpc('match_documents', {
  query_embedding: queryEmbedding,
  match_count: 5,
})
```

Vectors come back from the REST API as text, such as `"[0.1,0.2,0.3]"`, as on Supabase. `JSON.parse()` turns one into an array.

pgvector also has `halfvec` (half the storage), `sparsevec` and `bit` types, and `ivfflat` indexes. See the [pgvector documentation](https://github.com/pgvector/pgvector#readme) for all of them and for tuning indexes.

::: tip Making embeddings
Keel stores and searches vectors; it doesn't make them. Call an embedding model from an [edge function](/functions/overview), your app or a local model server such as Ollama on your network ([allow it for functions](/functions/overview) first).
:::

## Maps and places with PostGIS

PostGIS adds `geometry` and `geography` types, spatial indexes and hundreds of `st_*` functions. Enable it in Studio's SQL editor:

```sql
create extension if not exists postgis with schema extensions;
```

Then, in a migration or the SQL editor:

```sql
create table places (
  id bigint generated always as identity primary key,
  name text not null,
  location geography(point) not null    -- longitude and latitude (WGS 84)
);
create index on places using gist (location);

-- Places within a distance, nearest first.
create function places_within(lat float, lng float, meters float)
returns setof places
language sql stable as $$
  select * from places
   where st_dwithin(location, st_point(lng, lat)::geography, meters)
   order by location <-> st_point(lng, lat)::geography
$$;
```

```js
await supabase.from('places').insert({ name: 'Office', location: 'POINT(13.405 52.52)' })

const { data } = await supabase.rpc('places_within', { lat: 52.52, lng: 13.4, meters: 5000 })
```

`geography` columns accept WKT text such as `POINT(lng lat)` (longitude first) and come back as hex-encoded EWKB; select `st_asgeojson(location)` in a view or function for GeoJSON. With PostGIS enabled, `.geojson()` in `supabase-js` returns rows as a GeoJSON `FeatureCollection`.

Keel's PostGIS is built without raster support (`postgis_raster`, which needs GDAL and would add about 150 MB to the image) and without the address standardizer. `postgis_topology` and `postgis_tiger_geocoder` are included.

## Other extensions

Everything that ships with Postgres 17 is available too. Some useful ones:

| Extension | What it's for |
|---|---|
| `pg_trgm` | Fast `like` / `ilike` searches and fuzzy matching with trigram indexes. |
| `citext` | Case-insensitive text, handy for emails and usernames. |
| `unaccent` | Strip accents for searching. |
| `moddatetime` | A ready-made trigger that sets an `updated_at` column. |
| `ltree` | Tree paths such as categories. |
| `hstore` | Key-value pairs in one column. |
| `btree_gin`, `btree_gist` | Mix ordinary columns into GIN and GiST indexes, for example exclusion constraints on bookings. |
| `pg_stat_statements` | Statistics on slow and frequent queries. Already preloaded by Keel; create it to query it. |

To see everything that's available, and what's installed in the current project:

```sql
select name, default_version, installed_version, comment
  from pg_available_extensions order by name;
```

::: info Not included
Supabase's platform extensions aren't in the image: `pg_cron`, `pg_net`, `pg_graphql`, `pgsodium`, Vault and `wrappers`. If you [import a Supabase project](/self-hosting/migrate-from-supabase) that uses them, the importer lists what it had to skip. `vector` and `postgis` are recreated by the importer.
:::

## Updating

The extension versions come with Keel's releases (pgvector 0.8.7 and PostGIS 3.6.4 today). After an update that brings a newer version, existing projects keep the old one until you update it, in the SQL editor:

```sql
alter extension vector update;
alter extension postgis update;   -- or: select postgis_extensions_upgrade();
```

Installs from before `keel-postgres` (Keel 0.2 and earlier) ran the plain `postgres:17-alpine` image. Running the [installer](/self-hosting/updating) again switches `keel-db` to `keel-postgres`; your data stays as it is, since both are the same Postgres 17.
