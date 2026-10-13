# Connecting directly

Each project's database is a regular Postgres 17 database. Connect to it with `psql`, a GUI tool, an ORM or a migration tool, using the connection string from Studio. It logs in as the project's owner role (`my_app_owner` for `my_app`), which owns the project's tables, so their row level security policies don't apply to it: use it from your own computer and servers, never from browsers or apps you hand out. It isn't a superuser and can't reach other projects; see [The project owner role](/self-hosting/security#the-project-owner-role). The `postgres` superuser is for server admins (`./keel psql`).

```bash
psql 'postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require'
```

## Connection details

Click **Connect** in Studio's header and copy **Postgres connection**. The `.env` tab has it as `DATABASE_URL`:

```text
postgresql://my_app_owner:<password>@192.168.1.20:5432/my_app?sslmode=require
```

| Setting | Value |
|---|---|
| Host | Your server's address. Studio uses the host name from `KEEL_PUBLIC_URL`, or `KEEL_PUBLIC_DB_HOST` when it's set. |
| Port | `5432`, or `KEEL_DB_PORT` if you changed it. |
| Database | The project name with dashes turned into underscores: `my-app` → `my_app`. |
| User | The database name followed by `_owner`: `my_app_owner`. |
| Password | Generated for each project. Studio's copy button next to **Postgres connection** includes it. |
| SSL | `require`: the connection is encrypted. Postgres only accepts TLS from other machines; see [TLS](#tls). |

If `KEEL_PUBLIC_URL` is a domain name that points to a reverse proxy (for HTTPS), the host in Studio's connection string goes to the proxy, which only forwards web traffic. Use the server's own IP address, or Tailscale name, instead. To make Studio show that address, set `KEEL_PUBLIC_DB_HOST` (see [Configuration](/self-hosting/configuration#network)).

The installer and `./keel init` generate a password of letters and digits. If you set your own and it contains characters such as `@`, `:` or `/`, [percent-encode](https://developer.mozilla.org/en-US/docs/Glossary/Percent-encoding) them in the URL.

## TLS

Postgres uses TLS with a certificate Keel makes on first start (in the `db-tls` folder of your install). Connections from other machines must use it, so Studio's connection string ends in `?sslmode=require`: encrypted, without checking the certificate, which is self-signed. `psql`, `pg_dump`, GUI tools, Prisma and the Supabase CLI read it that way. If Postgres has no certificate, it runs without TLS, accepts only this machine and Keel's own containers, and Studio leaves `sslmode` out.

**node-postgres** (`pg`, and Drizzle, Kysely and Knex on top of it) reads `sslmode=require` as `verify-full` and refuses the self-signed certificate with `self-signed certificate`. A `ssl` option next to `connectionString` doesn't help, as the URL's `sslmode` wins. Add `uselibpqcompat=true` to the URL to get the meaning above:

```bash
DATABASE_URL="postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require&uselibpqcompat=true"
```

`uselibpqcompat` needs a recent `pg` (older versions ignore it and still refuse the certificate) and is for node-postgres only; leave it out of strings for `psql` and other tools, which refuse parameters they don't know.

`require` stops anyone on the network from reading the traffic, but not a device on your network that pretends to be the server: without checking the certificate, a client would hand its connection (and everything sent over it) to an impostor. To rule that out, copy `db-tls/server.crt` (only that file: never `server.key`) from the install folder next to your app and check against it with `sslmode=verify-ca`:

```bash
psql 'postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=verify-ca&sslrootcert=./server.crt'
DATABASE_URL="postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=verify-ca&sslrootcert=./server.crt&uselibpqcompat=true"
```

`verify-ca` checks the certificate but not the host name, as the certificate only names `keel-db`, `localhost` and `127.0.0.1`; `KEEL_DB_URL` for the [keel CLI](/self-hosting/cli) accepts the same settings. This is the better choice whenever you can copy the file.

## psql

On the server, `./keel psql` opens `psql` inside the database container, so you don't need to install anything:

```bash
./keel psql my-app
```

Without a project name it opens the database of `KEEL_DEFAULT_PROJECT` (`my-app` unless you changed it). Type `\q` to leave.

From another computer with `psql` installed, use the connection string:

```bash
psql 'postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require'
```

To run a SQL file, pass it with `-f`, or pipe it into `./keel psql` (or into the container with `docker compose exec`) from the `keel` folder on the server:

```bash
psql 'postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require' -v ON_ERROR_STOP=1 -f schema.sql

./keel psql my-app < schema.sql

docker compose exec -T keel-db psql -U postgres -d my_app -v ON_ERROR_STOP=1 < schema.sql
```

`-v ON_ERROR_STOP=1` stops at the first error instead of running the rest of the file. `./keel psql` doesn't pass extra options to `psql`, so use one of the other two lines when you need it.

## GUI tools

TablePlus, DBeaver, pgAdmin, Postico, DataGrip and other Postgres clients all work. Create a PostgreSQL connection with the values from the table above. Most can also take the whole connection string.

Each project is its own database, so add one connection per project, or pick the database after connecting. You'll also see `keel`, where Keel stores its projects, keys and settings, and `postgres`. Leave those two alone.

## ORMs and query builders

Prisma, Drizzle, Kysely, Knex, SQLAlchemy, Django and anything else that speaks Postgres connect with the same string (for node-postgres and the tools built on it, add `&uselibpqcompat=true`, see [TLS](#tls)). Keep it in an environment variable:

```bash
DATABASE_URL="postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require"
```

::: code-group

```prisma [Prisma]
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```ts [Drizzle]
import { drizzle } from 'drizzle-orm/node-postgres'

export const db = drizzle(process.env.DATABASE_URL!)
```

:::

::: warning Row level security doesn't apply
An ORM connected with the connection string (the owner role, `my_app_owner`) reads and writes every row of the tables it owns, whatever your policies say. Code that uses it must check for itself what each user is allowed to do. If you want your policies to apply, call the API with `supabase-js` and the user's session instead.
:::

Things to keep in mind when a tool manages your schema:

- **Let it manage `public` only.** `auth`, `storage`, `realtime`, `extensions` and `_keel` belong to Keel. Most tools only look at `public` by default; don't let one drop or rewrite the others. Foreign keys from your tables to `auth.users` are fine.
- **Don't drop the `public` schema.** Some "reset" commands drop and recreate it, which removes the permissions Keel gave the API roles, and your API stops working. If it happens, restore them:

  ```sql
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant all on all sequences in schema public to anon, authenticated, service_role;
  grant all on all routines in schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on routines to anon, authenticated, service_role;
  alter default privileges for role my_app_owner in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role my_app_owner in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges for role my_app_owner in schema public grant all on routines to anon, authenticated, service_role;
  ```

  Run these as the `postgres` superuser (Studio's SQL editor or `./keel psql my-app`), with your project's owner role in place of `my_app_owner`.

- **New tables get row level security** automatically, so add the policies in the same migration, or the API returns no rows.

## Migrations

Keel doesn't have a migration command of its own: there's no `supabase db push` or `supabase_migrations` table. Two approaches work well:

**Plain SQL files in git.** Keep each change in a numbered file (`migrations/001_create_todos.sql`, `migrations/002_add_due_date.sql`) and apply new ones in order with `psql -v ON_ERROR_STOP=1 -f`. Write them so a rerun is harmless where you can (`create table if not exists`, `create or replace function`, `drop policy if exists` before `create policy`). If you already have a `supabase/migrations` folder, apply its files the same way, oldest first.

**A migration tool** that records what it has applied: Prisma Migrate, Drizzle Kit, dbmate, Flyway, Sqitch, Alembic and others. Point it at the connection string.

Either way:

- **Try changes on a copy first.** Projects are cheap: create `my-app-staging` in Studio and run the migration there.
- **Back up before big changes,** with **Back up now** in Studio's side panel. See [Backups and restore](/self-hosting/backups).
- **Include everything the API needs** in the migration: policies, grants for any schema besides `public`, and realtime (`alter publication supabase_realtime add table ...`, see [Database changes](/realtime/postgres-changes)).
- The REST API picks up schema changes by itself; nothing needs restarting.

## Network access

By default, Postgres listens on the server itself only, so tools on other machines can't reach it until you open it. Two settings in `.env` change that, applied with `./keel up` (or install with `--lan-db`):

| Setting | Default | What it does |
|---|---|---|
| `KEEL_DB_BIND` | `127.0.0.1` | The address Postgres is published on. `0.0.0.0` opens it to your network. |
| `KEEL_DB_PORT` | `5432` | The published port. Studio's connection string follows it. |

These apply to every install that keeps its settings in `.env`. In the ZimaOS App Store file, change Postgres' `ports:` line instead (`"0.0.0.0:5432:5432"` to open it).

Connections from other machines are encrypted with [TLS](#tls), and the `postgres` superuser is refused from them unless you set `KEEL_DB_REMOTE_SUPERUSER=on` (see [Postgres connections](/self-hosting/security#postgres-connections)), but the certificate is self-signed and `sslmode=require` doesn't check it (use `verify-ca`, see [TLS](#tls)), so **don't open port 5432 to the internet**. To work with the database from elsewhere, use [Tailscale](/self-hosting/remote-access) or an SSH tunnel:

```bash
# On your laptop: forward local port 5433 to Postgres on the server
ssh -N -L 5433:127.0.0.1:5432 you@192.168.1.20

# In another terminal
psql 'postgresql://my_app_owner:OWNER_PASSWORD@localhost:5433/my_app?sslmode=require'
```

The tunnel works even with `KEEL_DB_BIND=127.0.0.1`, which makes it a good combination: no open database port on your network at all.

## Connections and pooling

Keel has no connection pooler: there's no Supavisor or PgBouncer, and no port 6543. Clients connect straight to Postgres.

Postgres runs with its default limit of **100 connections**, shared by every project on the server and by Keel's own services, which keep small pools of connections per project (each project's REST server uses up to 10). For your own code:

- Use one small pool per process rather than a connection per request (for example `max: 5` in `node-postgres`, or `?connection_limit=5` in a Prisma URL).
- Be careful with serverless platforms and many workers: each instance opens its own connections.

If you run many projects or busy workers and see "sorry, too many clients already", raise the limit and restart the stack:

```sql
alter system set max_connections = 200;
```

```bash
./keel down && ./keel up
```

Each connection uses some memory, so raise it in steps on small machines.

Direct connections have no statement timeout, unlike API requests (3 seconds for `anon`, 8 for signed-in users), which makes them the place for long reports, bulk loads and data fixes.
