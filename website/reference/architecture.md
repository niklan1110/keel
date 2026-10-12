# Architecture

This page explains how Keel's pieces fit together: the containers, how a request travels through them, how databases and roles are laid out, and where the security boundaries are. It's useful when you debug a running server or want to contribute.

```text
 apps (supabase-js, curl, psql)                 browser
          │                                        │
   :8000  ▼                                 :3000  ▼
 ┌────────────────┐                       ┌──────────────┐     ┌─────────────┐
 │  keel-gateway  │                       │ keel-studio  │────▶│ keel-docker │
 └───────┬────────┘                       └──────┬───────┘     └─────────────┘
   /<project>/rest|auth|storage|realtime|functions │  admin API, SQL, pg_dump
   ┌──────────┬───────────┬────────────┬──────────┐│
   ▼          ▼           ▼            ▼          ▼▼
keel-rest  keel-auth  keel-storage keel-realtime keel-functions
(PostgREST            │            (logical      (one Deno process
 per project)         ▼             replication)  per function)
   │          │   keel-imgproxy        │
   └──────────┴───────────┬────────────┘
                          ▼
                 keel-db (Postgres 17)
        one database per project + the "keel" control database
```

## Containers

| Service | Image | Port | Role |
|---|---|---|---|
| `keel-db` | `keel-postgres` | 5432 (published) | All data. The official `postgres:17-alpine` image plus [pgvector and PostGIS](/database/extensions). Runs with `wal_level=logical` for realtime and preloads `pg_stat_statements`. |
| `keel-db-tls` | `keel` | | Runs before `keel-db` on every start: makes Postgres' self-signed TLS certificate the first time, then idles. No network. |
| `keel-migrate` | `keel` | | Runs on every start: creates roles and the control database, applies pending schema upgrades to every project and creates the first project. The other Keel services start only after it finishes successfully. In the installer's and ZimaOS compose files it then stays running, idle, so panels that expect every container to keep running are happy. |
| `keel-gateway` | `keel` | 8000 (published) | The public entry point. Routes `/<project>/<service>/v1/...`, checks API keys, adds CORS headers and proxies WebSockets. |
| `keel-rest` | `keel` | 3000 | Supervises one PostgREST 12 process per project (on ports from 3100 up) and routes each project's requests to it. |
| `keel-auth` | `keel` | 9999 | The GoTrue-compatible auth API for all projects. |
| `keel-storage` | `keel` | 5000 | The storage API for all projects. Files are kept in the storage folder (`/var/lib/keel/storage`). |
| `keel-imgproxy` | `darthsim/imgproxy` | 8080 | Resizes images for `/render/image/...` URLs. Reads the storage folder read-only. |
| `keel-realtime` | `keel` | 4000 | The Phoenix-protocol WebSocket server for all projects. |
| `keel-functions` | `keel-functions` | 9000 | Runs edge functions, one Deno process per function, on demand. |
| `keel-studio` | `keel` | 3000 (published) | The dashboard, its management API, scheduled backups, [scheduled jobs](/database/cron) and these docs. |
| `keel-egress` | `keel` | | Sends the [HTTP requests your SQL queues](/database/webhooks) (`net.http_post`, database webhooks). It has no superuser password, can only work the request queues, and sits on a network of its own with the database and the gateway. |
| `keel-tunnel` | `keel` | | Runs Cloudflare's tunnel client when a token has been saved in Studio. Only on the `keel-public` network, with the gateway and Studio. |
| `keel-docker` | `keel` | 2375 | Lets Studio list Keel's containers, read their logs and start, stop or restart them. Nothing else, and other apps' containers stay hidden. |

Only the gateway, Studio and Postgres are published on the host. The other ports are on Docker's internal network.

The core services share one image; the container's command picks the service (`node server/dist/main.js <service>`). The image starts from the Postgres image's filesystem, so `pg_dump` and `pg_restore` match the server version. Edge functions use a second image, `keel-functions`: Node.js plus the Deno binary on Debian, because Deno needs glibc. `keel-db` runs the third, `keel-postgres`: the same Postgres image with pgvector and PostGIS built in, so the server and `pg_dump` are always the same version.

The same image also runs the one-off commands behind the [keel CLI](/self-hosting/cli): deploying and listing functions, managing secrets, importing from Supabase, managing Studio accounts, rolling API keys, restoring full backups and generating a `.env` file.

## Request flow

Take `GET http://server:8000/recipe-box/rest/v1/recipes`:

1. **keel-gateway** splits the path into the project (`recipe-box`), the service (`rest`) and the rest of the path. An unknown project gets the same `401` as a wrong API key (`404` for storage and function URLs).
2. It checks the `apikey` header (or `?apikey=` query parameter): it must be a JWT signed with this project's secret, for the `anon` or `service_role` role. Storage and edge functions skip this step because they check tokens themselves (so public file URLs and webhooks work), and so do the auth routes a browser lands on from an email or OAuth provider (`/verify`, `/callback`, `/authorize`).
3. It forwards the request with an `x-keel-project` header and the caller's address appended to `X-Forwarded-For`, replaces any CORS headers from the service with its own, and logs one line per request.
4. **REST** requests go to keel-rest, which passes them to the project's PostgREST process. If there's no `Authorization` header, the gateway uses the API key as the bearer token, and it removes an `apikey` query parameter so PostgREST doesn't read it as a filter. PostgREST verifies the token with the project's secret, switches to the token's role (`anon`, `authenticated` or `service_role`) and sets `request.jwt.claims`, so `auth.uid()` works in policies.
5. **Auth, storage and realtime** requests go to the shared services, which pick the project from `x-keel-project` and verify tokens with that project's secret. Storage runs every query as the caller's role, so policies on `storage.objects` apply.
6. **Function** requests go to keel-functions, which checks the JWT (unless the function has `verify_jwt` off) and passes the request to the function's process. The function sees the path `/<name>/...`, as on Supabase.

## Databases

One Postgres server holds:

- **A database per project**, named after the project with dashes turned into underscores (`recipe-box` uses `recipe_box`).
- **The control database, `keel`**, with Keel's own tables in the `keel` schema.

### The control database

| Table | What it holds |
|---|---|
| `keel.projects` | One row per project: name, database name, internal secret, anon and service role keys, and settings (auth, SMTP, phone, MFA, realtime) as JSON |
| `keel.project_jwt_keys` | Each project's signing keys: id, secret, and when an old one stops verifying |
| `keel.project_key_events` | Who rolled or stopped which keys, and when |
| `keel.functions` | Each edge function's source files, entrypoint, `verify_jwt` flag and version |
| `keel.function_secrets` | Environment variables for each project's functions |
| `keel.saved_queries` | The SQL editor's saved queries |
| `keel.backups` | The list of backup files and whether they succeeded |

Every service keeps an in-memory copy of `keel.projects` and reloads it when a trigger sends `NOTIFY keel_projects`. New projects and settings changes apply within a second, without restarts; keel-rest starts or restarts the matching PostgREST process. `keel.functions` and `keel.function_secrets` notify `keel_functions` in the same way.

### Inside a project database

| Schema | Contents |
|---|---|
| `public` | Your tables. `anon`, `authenticated` and `service_role` get table privileges by default, as on Supabase; row level security decides what each caller sees. |
| `extensions` | `pgcrypto` and `uuid-ossp`, and any extensions you add there. |
| `auth` | `users`, `identities`, `sessions`, `refresh_tokens` (hashed), `one_time_tokens` (hashed), `flow_state`, `mfa_factors`, `mfa_challenges`. Column names match GoTrue, so Supabase triggers and exports work. Helpers: `auth.uid()`, `auth.role()`, `auth.email()`, `auth.jwt()`. |
| `storage` | `buckets` and `objects` (with RLS on), and `storage.foldername()`, `storage.filename()`, `storage.extension()`. |
| `realtime` | `messages` (with RLS on; its policies authorize private channels), `realtime.topic()`, `realtime.send()`, `realtime.broadcast_changes()`. |
| `_keel` | Keel's bookkeeping, such as the list of applied migrations. Not reachable by API roles. |

The publication `supabase_realtime` lists the tables that stream changes. Two event triggers run after schema changes: one tells PostgREST to reload its schema cache (so new tables appear in the API at once), the other switches on row level security for new tables in `public` unless `keel.auto_rls` is `off` for the database.

## Roles

Roles are created once per Postgres server, except each project's owner role. Each service role has its own password, derived from `KEEL_SERVICE_PASSWORD` by `keel-migrate`, and only the service that uses it gets it (see [Database roles](/self-hosting/security#database-roles)).

| Role | Logs in | Used by | Notes |
|---|---|---|---|
| `postgres` | yes | Studio, migrations, backups | Superuser. |
| `authenticator` | yes | PostgREST, gateway | Switches into `anon`, `authenticated` or `service_role` for each request. |
| `anon`, `authenticated` | no | API requests | Subject to row level security. Statement timeouts of 3 and 8 seconds. |
| `service_role` | no | Requests with the service role key | Bypasses row level security. |
| `keel_auth_admin` | yes | keel-auth | Owns the `auth` schema. |
| `keel_storage_admin` | yes | keel-storage | Owns the `storage` schema and switches into the caller's role, so storage policies apply. |
| `keel_realtime_admin` | yes | keel-realtime | Has the `replication` attribute. Owns the `realtime` schema and switches into subscribers' roles to check policies. |
| `keel_functions_admin` | yes | keel-functions | Reads deployed functions and secrets from the control database. Can't connect to project databases. |
| `keel_egress_admin` | yes | keel-egress | Takes requests off each project's `net.http_request_queue` and writes `net._http_response`. Nothing else in a project, and only project names in the control database. |
| `<database>_owner` | yes | Studio's Connect panel, developers, coding agents | One per project. Owns the `public` schema, bypasses row level security, isn't a superuser and can only connect to its own project (and deploy its functions). |

Nobody can connect to a project database or the control database by default (`CONNECT` is revoked from `PUBLIC`); each service role, and a project's owner role for its own database, is granted it explicitly. Services read `keel.projects` through `keel.visible_projects`, which shows each role only the columns it uses.

## How a project is created

When you create a project in Studio (or `keel-migrate` creates the first one):

1. The name is checked against the rules in [Limits](/reference/limits).
2. Keel creates the database and applies every project migration to it.
3. It generates the project's first signing key (48 random bytes and a key id) and a separate internal secret, and signs the anon and service role keys with the signing key. The keys carry `ref: <project>`, name the key in their `kid` header and are valid for 10 years. See [API keys and rotation](/guide/api-keys).
4. It inserts the row into `keel.projects`. The notification tells every service about the new project, and keel-rest starts its PostgREST process.

Deleting a project removes the row first (so services stop routing to it), then drops the database. Uploaded files stay in the storage folder.

## Migrations

Keel's schema lives in SQL files in the repository:

- `server/sql/cluster/` creates the roles and the control database's tables. These files are idempotent and run on every start.
- `server/sql/project/` holds numbered migrations (`001_base.sql`, `002_auth.sql`, ...) for project databases. Each project records the versions it has in `_keel.migrations`; pending ones are applied in order, each in its own transaction.

`keel-migrate` runs both every time the stack starts, before any other Keel service starts, so updating Keel upgrades every project automatically. If a migration fails, it's rolled back, `keel-migrate` stops with the error (see `./keel logs keel-migrate`) and the other services don't start until the problem is fixed.

## Realtime

- **Database changes.** When the first client in a project subscribes to `postgres_changes`, keel-realtime opens a temporary logical replication slot for that project's database and decodes changes with Postgres's built-in `pgoutput` plugin, so no extension is needed. A join is confirmed only once the slot exists (and the project's listener for database broadcasts is running), so nothing committed after the client sees `SUBSCRIBED` is missed. The slot is dropped about a minute after the last subscriber leaves, and temporary slots disappear if the connection drops, so a stopped Keel never makes Postgres keep old WAL around.
- **Row level security.** For each change and subscriber, tables without RLS are delivered if the subscriber's role may `select` from the table. For inserts and updates on tables with RLS, keel-realtime selects the row by primary key as the subscriber, with their JWT claims. Deleted rows can't be selected, so for deletes it evaluates the table's `select` policies against the old row; that needs `REPLICA IDENTITY FULL`, which Studio sets when you switch on realtime for a table.
- **Private channels.** When a client joins a private channel, keel-realtime inserts test rows into `realtime.messages` inside a transaction that is always rolled back, and checks as the subscriber which ones are visible (may receive) and whether the insert is allowed (may send), separately for broadcast and presence. The check runs again when the client sends a new token. Public and private channels with the same name are separate rooms.
- **Broadcast from the database.** An insert into `realtime.messages` (by `realtime.send()` or `realtime.broadcast_changes()`) sends `NOTIFY keel_realtime_messages` with the row's ID. keel-realtime keeps one listening connection per project with open channels, reads the row and delivers it. Rows older than a day are deleted every hour.
- **Wire protocol.** Phoenix channels with serializer 1.0.0 (JSON objects) and 2.0.0 (JSON arrays plus binary broadcast frames), matching `@supabase/realtime-js`. Channels close when the subscriber's token expires.

## Edge functions

- keel-gateway forwards `/<project>/functions/v1/<name>/...` to keel-functions, which checks the JWT (unless `verify_jwt` is off) and proxies the request to the function's process over a Unix socket.
- On the first request, the function's files are written to the functions folder (`/var/lib/keel/functions`) and a Deno process starts with Keel's bootstrap script, which loads the entrypoint, captures the handler passed to `Deno.serve` (or a default export's `fetch`) and serves it on the socket. Deno's module cache for `npm:`, `jsr:` and URL imports is shared between functions.
- **Permissions.** Network access, environment variables, system information and imports are allowed. A function can read only its own code, its temporary folder and the module cache, and write only its temporary folder. Subprocesses and native libraries aren't allowed. The environment holds only the project's secrets, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (pointing at the gateway inside Docker), and proxy settings.
- **Network.** Deno gets `--allow-net` with every private and special IPv4 range (and `::`, `::1`, the container's own addresses and the server's public address) in `--deny-net`; Deno checks those against the resolved address of each connection. Requests to `SUPABASE_URL` go through a Unix socket in the function's temporary folder (the bootstrap sets a Deno HTTP client with a Unix proxy on `fetch` and `WebSocket` for that origin), which keel-functions forwards to the gateway for that function's project only.
- A process stops after `KEEL_FUNCTIONS_IDLE` seconds without requests, when a new version or new secrets arrive (after requests in flight finish), or to stay under `KEEL_FUNCTIONS_MAX_WORKERS`.
- Console output and recent requests are kept in memory for Studio. Studio reads them from internal endpoints that need `KEEL_FUNCTIONS_TOKEN` (or a token derived from the service password) and can't be reached through the gateway. keel-functions doesn't get `KEEL_SECRET`.

## Storage and backups

- File bytes live at `<storage root>/<database>/<bucket>/<object id>/<version>`. Paths are built from IDs, never from object names, so a name can't escape the storage root. Overwriting a file writes a new version and deletes the old one after the database commit.
- Signed URLs are JWTs signed with the project's secret, scoped to one object and to downloading or uploading.
- Resumable uploads keep partial files in a `.uploads` folder next to the project's files, and check storage policies when the upload is created and again when the last byte arrives.
- Studio runs `pg_dump --format=custom` for each project into the backups folder (`/var/lib/keel/backups`), nightly at `KEEL_BACKUP_SCHEDULE` and whenever you click **Back up now**. Restores use `pg_restore --single-transaction`, so a failed restore leaves the database unchanged. Uploaded files aren't in the dump.
- With `KEEL_BACKUP_PASSPHRASE` set, Studio also writes a nightly full backup: every database and uploaded file in one age-encrypted tar file, uploaded to an S3-compatible bucket. `./keel restore` puts one back. See [Backups and restore](/self-hosting/backups).

## Security boundaries

- **Projects are isolated by secret.** Each project signs its keys and user tokens with its own secret, and every service checks that a token belongs to the project in the URL. A key or token from one project is rejected by all others.
- **The API runs as low-privilege roles.** API requests run as `anon`, `authenticated` or `service_role`, never as a superuser, and row level security applies to the first two. New tables in `public` get RLS switched on.
- **Service roles do one job each.** Auth, storage and realtime each own only their own schema; keel-functions can read the control database but not project data.
- **Functions are sandboxed.** They get the network and their own temporary folder, but no other files, no subprocesses and no Keel or database passwords.
- **Studio is the superuser.** It runs SQL as `postgres` and reaches Docker only through `keel-docker`, which sits on a private network and can't create containers or run commands. Protect Studio's password, and consider keeping port 3000 off the internet. See [Security](/self-hosting/security).
- **Files can't run script on your API's address.** Storage serves files with `X-Content-Type-Options: nosniff`, and anything that isn't a passive type (images other than SVG, audio, video, fonts, PDF, plain text, JSON, archives) with a sandboxing Content Security Policy.
