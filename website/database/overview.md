# Overview

Every Keel project has its own Postgres 17 database. Keel turns the tables, views and functions in its `public` schema into a REST API, so your app can read and write data with `supabase-js`. Row level security decides what each request is allowed to see.

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

const { data, error } = await keel
  .from('recipes')
  .select('title, servings, author:profiles(display_name)')
  .eq('is_public', true)
```

## One database per project

All projects share one Postgres server, the `keel-db` container, and each project gets a database of its own, named after the project with dashes turned into underscores: the project `my-app` uses the database `my_app`. Projects can't see each other's data.

The same server also holds two databases that aren't yours to change: `keel`, where Keel keeps its list of projects, keys and settings, and `postgres`, the default database that comes with every Postgres install.

You can work with a project's database in four ways:

| | |
|---|---|
| **Studio** | The canvas shows your tables and their foreign keys. Click a table to browse and edit rows and manage its policies. See [Tables and data](/database/tables). |
| **SQL editor** | Run any SQL as the database superuser, from **SQL** in Studio's dock. See [SQL editor](/studio/sql-editor). |
| **REST API** | What your apps use, through `supabase-js` or plain HTTP. See [Querying with the API](/database/querying). |
| **Direct connection** | `psql`, GUI tools, ORMs and migration tools. See [Connecting directly](/database/connecting-directly). |

## Schemas

A schema is a namespace inside a database: `public.recipes` and `auth.users` are tables in two different schemas. Each project database starts with these:

| Schema | What's in it | In the REST API |
|---|---|---|
| `public` | Your tables, views and functions. | Yes |
| `auth` | Users and their sign-in data: `users`, `identities`, `sessions`, `mfa_factors` and more, plus the helpers `auth.uid()`, `auth.role()`, `auth.email()` and `auth.jwt()`. Managed by Keel's auth service. | No |
| `storage` | `buckets` and `objects`, the metadata for your files (the bytes live on a separate volume), plus `storage.foldername()`, `storage.filename()` and `storage.extension()`. | No, use the [Storage API](/storage/overview) |
| `realtime` | `messages`, which authorizes [private channels](/realtime/authorization), plus `realtime.topic()`, `realtime.send()` and `realtime.broadcast_changes()`. | No |
| `extensions` | `pgcrypto`, `uuid-ossp` and any extensions you add. | No |
| `_keel` | Keel's record of which schema upgrades it has applied to this database. | No |

The table and column names in `auth`, `storage` and `realtime` match Supabase's, so triggers on `auth.users` and policies on `storage.objects` written for Supabase work in Keel. Add your own triggers and policies there, but leave the tables' structure alone: Keel's services depend on it.

Studio shows one schema at a time. Switch with the schema name in the project card of the side panel ("3 tables in **public**").

## The REST API

Each project runs its own [PostgREST](https://postgrest.org) 12.2 server, the same engine Supabase uses. It reads your schema and serves every table, view and function in `public` at:

```text
http://localhost:8000/my-app/rest/v1/
```

- **Your schema is the API.** Create a table and it's an endpoint, a moment later. Keel tells PostgREST to reload its schema after every `create`, `alter`, `drop` or `grant`, so there's nothing to restart or regenerate.
- **Foreign keys become joins.** A `select` can pull in related rows through foreign keys (`author:profiles(display_name)` above).
- **Functions become endpoints.** Call them with `keel.rpc()`. See [Database functions](/database/functions).
- **Only `public` is exposed.** Put helper tables and functions that apps shouldn't call directly in another schema, such as `private`.

The API has a few built-in limits:

| Limit | Value |
|---|---|
| Rows returned per request | 1,000. Use `.range()` to page through more. |
| Statement timeout for the `anon` role | 3 seconds |
| Statement timeout for the `authenticated` role | 8 seconds |

A query that runs longer than its timeout is canceled and returns an error with code `57014`. For slow reports, add an index, or run them from a server over a [direct connection](/database/connecting-directly), which has no timeout.

### Exposing other schemas

Studio has no setting for this yet, but each project's REST server reads two optional values from the project's settings in the `keel` database: `schemas` (extra schemas to expose, after `public`) and `max_rows` (the row cap above). To change them, open `psql` on the control database on your server:

```bash
./keel psql keel
```

```sql
update keel.projects
set settings = settings || '{"rest": {"schemas": ["api"], "max_rows": 2000}}'::jsonb
where name = 'my-app';
```

The project's REST server restarts with the new settings within a few seconds. Then grant the API roles access to the schema in the project's database, and select it in your client with `keel.schema('api').from('things')` (which sends the `Accept-Profile` header):

```sql
grant usage on schema api to anon, authenticated, service_role;
grant select on all tables in schema api to anon, authenticated, service_role;
```

::: warning
Tables you create in schemas other than `public` don't get row level security switched on automatically. Enable it yourself before you expose the schema.
:::

## Roles

Postgres decides what a query may do based on the **role** it runs as. Every API request runs as one of three roles, picked from the `role` claim of the request's token. Direct connections use the project's owner role, and Studio the `postgres` superuser:

| Role | Used for | Row level security |
|---|---|---|
| `anon` | Requests with only the anon key: visitors who aren't signed in. | Applies |
| `authenticated` | Requests with a signed-in user's access token, including [anonymous users](/auth/anonymous). | Applies |
| `service_role` | Requests with the service role key, from your servers and scripts. | Bypassed |
| `my_app_owner` | Direct connections, migrations and coding agents ([connection string from Studio](/database/connecting-directly)). Owns `public` and what's in it. | Doesn't apply to the tables it owns; it can't reach other projects |
| `postgres` | Studio (SQL editor and table views), `./keel psql`, backups. | Bypassed (superuser) |

As on Supabase, the three API roles have full table privileges on everything created in `public`: tables, sequences and functions. That keeps the API working without `grant` statements, and it means [row level security](/database/row-level-security) is what protects your data.

Keel's services also have their own roles: `authenticator` (PostgREST logs in as it, then switches to one of the API roles); `keel_auth_admin`, `keel_storage_admin` and `keel_realtime_admin`, which own the `auth`, `storage` and `realtime` schemas; `keel_functions_admin`, which only reads deployed functions from the control database; and `keel_egress_admin`, which only sends the requests queued by `net.http_*` and webhooks. You don't need to use them. What a superuser creates in `public` is handed to the project's owner role, so migrations run as the owner can change it.

::: tip
If you create tables while logged in as a role other than `postgres`, for example a dedicated migration user, the default grants don't apply. Grant the API roles access yourself.
:::

## Extensions

Each project database comes with `pgcrypto` and `uuid-ossp` installed in the `extensions` schema. The schema is on the search path, so you can call their functions without a prefix, for example `uuid_generate_v4()` or `crypt()`. (`gen_random_uuid()` is built into Postgres and needs no extension.)

Keel's database runs the `keel-postgres` image: Postgres 17 with [pgvector](./extensions#vector-search-with-pgvector) for vector search and [PostGIS](./extensions#maps-and-places-with-postgis) for maps and places, plus every extension that ships with Postgres itself. Add one with SQL, in the `extensions` schema as on Supabase:

```sql
create extension if not exists vector with schema extensions;
```

See [Extensions](./extensions) for what's included, who can enable what, and examples.

## Next steps

<div class="cards">
  <a class="card" href="./tables"><strong>Tables and data</strong><span>Create tables in Studio or SQL, edit rows and load sample data.</span></a>
  <a class="card" href="./querying"><strong>Querying with the API</strong><span>Select, filter, join, paginate, insert and upsert.</span></a>
  <a class="card" href="./row-level-security"><strong>Row level security</strong><span>Policies for owners, teams, admins and MFA.</span></a>
  <a class="card" href="./functions"><strong>Database functions</strong><span>Call SQL functions from your app with RPC.</span></a>
  <a class="card" href="./extensions"><strong>Extensions</strong><span>Vector search with pgvector, maps with PostGIS, and more.</span></a>
  <a class="card" href="./connecting-directly"><strong>Connecting directly</strong><span>psql, GUI tools, ORMs and migrations.</span></a>
</div>
