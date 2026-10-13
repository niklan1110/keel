import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { GATEWAY, env, sql, studio, waitFor } from './helpers.js';

// keel-db runs keel-postgres: Postgres with pgvector and PostGIS. Apps enable
// them as on Supabase (in the `extensions` schema) and use them through the
// REST API. The tests run in a project of their own, so the extensions are
// created fresh and go away with it.

const name = `ext-${Date.now().toString(36)}`;
const db = name.replace(/-/g, '_');
const owner = `${db}_owner`;
const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
let ownerPassword;
let keys;

async function asOwner(text) {
  const c = new pg.Client({ host: env.KEEL_E2E_DB_HOST || 'localhost', port: Number(env.KEEL_DB_PORT || 5432), user: owner, password: ownerPassword, database: db });
  await c.connect();
  try {
    return await c.query(text);
  } finally {
    await c.end().catch(() => {});
  }
}

before(async () => {
  const r = await studio('POST', '/api/projects', { name });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ownerPassword = (await sql('keel', 'select password from keel.project_owners where project = $1', [name])).rows[0]?.password;
  keys = (await sql('keel', 'select anon_key, service_key from keel.projects where name = $1', [name])).rows[0];
  assert.ok(ownerPassword && keys);
});

after(async () => {
  await studio('DELETE', `/api/projects/${name}`, { confirm: name });
});

test('vector: the owner role enables it, and nearest-neighbour search works through RPC', async () => {
  // As in Supabase's docs, run by a migration as the project's owner role (not a superuser).
  await asOwner(`
    create extension vector with schema extensions;
    create table public.documents (
      id bigint generated always as identity primary key,
      content text not null,
      embedding vector(3) not null
    );
    create index on public.documents using hnsw (embedding vector_cosine_ops);
    alter table public.documents enable row level security;
    create policy "documents are public" on public.documents for select to anon, authenticated using (true);
    create function public.match_documents(query_embedding vector(3), match_count int)
    returns table (id bigint, content text, similarity float)
    language sql stable as $$
      select id, content, 1 - (embedding <=> query_embedding) as similarity
        from public.documents
       order by embedding <=> query_embedding
       limit match_count
    $$;
  `);
  const ext = (await sql(db, `select extnamespace::regnamespace::text as schema from pg_extension where extname = 'vector'`)).rows[0];
  assert.equal(ext?.schema, 'extensions');

  const admin = createClient(`${GATEWAY}/${name}`, keys.service_key, opts);
  // PostgREST reloads its schema cache after DDL; wait until it knows the table.
  const ins = await waitFor(
    async () => {
      const r = await admin
        .from('documents')
        .insert([
          { content: 'apples', embedding: [1, 0, 0] },
          { content: 'pears', embedding: [0.9, 0.1, 0] },
          { content: 'trains', embedding: [0, 0, 1] },
        ])
        .select('id, content, embedding');
      return r.error ? null : r;
    },
    { label: 'the documents table in the REST API' },
  );
  assert.equal(ins.data.length, 3);
  assert.equal(ins.data[0].embedding, '[1,0,0]', 'vectors come back in pgvector text form, as on Supabase');

  const anon = createClient(`${GATEWAY}/${name}`, keys.anon_key, opts);
  const { data, error } = await anon.rpc('match_documents', { query_embedding: [1, 0.05, 0], match_count: 2 });
  assert.equal(error, null);
  assert.deepEqual(data.map((r) => r.content), ['apples', 'pears']);
  assert.ok(data[0].similarity > 0.99 && data[0].similarity <= 1);

  // Plain SQL operators work too (extensions is on every role's search path).
  const near = await sql(db, `select content from public.documents order by embedding <-> '[0,0,0.9]' limit 1`);
  assert.equal(near.rows[0].content, 'trains');
});

test('PostGIS: available in the extensions schema, superuser-only to enable', async () => {
  await assert.rejects(asOwner('create extension postgis with schema extensions'), { code: '42501' }, 'PostGIS is not trusted');

  // Studio's SQL editor (the superuser) enables it; the owner role then uses it.
  await sql(db, 'create extension if not exists postgis with schema extensions');
  await asOwner(`
    create extension if not exists postgis with schema extensions;
    create table public.places (
      id bigint generated always as identity primary key,
      name text not null,
      location geography(point) not null
    );
    create index on public.places using gist (location);
    create function public.places_within(lat float, lng float, meters float)
    returns setof public.places
    language sql stable as $$
      select * from public.places
       where st_dwithin(location, st_point(lng, lat)::geography, meters)
       order by location <-> st_point(lng, lat)::geography
    $$;
    insert into public.places (name, location) values
      ('Brandenburg Gate', st_point(13.3777, 52.5163)),
      ('Alexanderplatz', st_point(13.4132, 52.5219)),
      ('Eiffel Tower', st_point(2.2945, 48.8584));
  `);

  const admin = createClient(`${GATEWAY}/${name}`, keys.service_key, opts);
  const data = await waitFor(
    async () => {
      const r = await admin.rpc('places_within', { lat: 52.52, lng: 13.40, meters: 5000 });
      return r.error ? null : r.data;
    },
    { label: 'places_within in the REST API' },
  );
  assert.deepEqual(data.map((r) => r.name).sort(), ['Alexanderplatz', 'Brandenburg Gate']);

  // With PostGIS, PostgREST answers in GeoJSON when asked.
  const geo = await admin.from('places').select('name, location').eq('name', 'Eiffel Tower').geojson();
  assert.equal(geo.error, null);
  assert.equal(geo.data.type, 'FeatureCollection');
  assert.equal(geo.data.features[0].properties.name, 'Eiffel Tower');
  assert.deepEqual(geo.data.features[0].geometry.coordinates, [2.2945, 48.8584]);

  const version = (await sql(db, 'select extensions.postgis_lib_version() as v')).rows[0].v;
  assert.match(version, /^3\./);
});
