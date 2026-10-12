# Keel architecture

This page explains how the pieces fit together, for contributors and for anyone debugging a running stack.

## Containers

| Service | Image | Port (internal) | Role |
|---|---|---|---|
| `keel-db` | `keel-postgres` | 5432 | All data. The official `postgres:17-alpine` image plus pgvector and PostGIS (the Dockerfile's `db` target). `wal_level=logical` for realtime, `pg_stat_statements` preloaded. |
| `keel-migrate` | `keel` | – | Runs once per `up`: creates roles and the control database, applies pending schema upgrades to every project, creates the first project. Other services start after it exits successfully. |
| `keel-gateway` | `keel` | 8000 (published) | Public entry point. Routes `/<project>/<service>/v1/...`, checks API keys, adds CORS headers, proxies WebSockets. |
| `keel-rest` | `keel` (+ PostgREST binary) | 3000 | Supervises one PostgREST process per project (ports 3100+) and routes `/<project>/...` to it. |
| `keel-auth` | `keel` | 9999 | GoTrue-compatible auth API for all projects. |
| `keel-storage` | `keel` | 5000 | Storage API for all projects. Files on the `keel-storage` volume. |
| `keel-imgproxy` | `darthsim/imgproxy` | 8080 | Resizes images for `/render/image/...`. Reads the storage volume read-only. |
| `keel-realtime` | `keel` | 4000 | Phoenix-protocol WebSocket server for all projects. |
| `keel-functions` | `keel-functions` | 9000 | Edge functions: one Deno process per deployed function, on demand. |
| `keel-studio` | `keel` | 3000 (published) | Dashboard UI and its management API, scheduled backups, scheduled jobs (cron). |
| `keel-egress` | `keel` | – | Sends the HTTP requests projects queue from SQL (`net.http_*`, database webhooks). On a network of its own (`egress`) with only the database and the gateway. |
| `keel-docker` | `keel` (`docker-proxy`) | 2375 | Lets Studio list Keel's containers, read logs and start/stop/restart them. Nothing else; other containers and all environment variables stay hidden. |

The core services come from one image; the container command picks the service (`node server/dist/main.js <service>`). It starts from the Postgres image's filesystem so `pg_dump`/`pg_restore` match the server version. Edge functions use a second image (`--target functions` in the Dockerfile): Node plus the Deno binary on Debian, since Deno needs glibc.

The same image also has one-off commands, used by `./keel`: `fn deploy|list|delete`, `secrets list|set|unset`, `import-supabase` and `generate-env`. `migrate --stay` keeps the migration container running (healthy once done) for NAS panels that expect every container to stay up; run as root, it first gives bind-mounted data folders to uid 1000.

## Projects

A project is a row in `keel.projects` (in the `keel` control database) plus a Postgres database named after it (`recipe-box` → `recipe_box`):

```
keel.projects(name, db_name, jwt_secret, anon_key, service_key, settings jsonb, created_at)
keel.project_jwt_keys(project, kid, secret, created_at, expires_at)   -- signing keys; several while rolling
keel.project_key_events(project, action, kid, actor, detail, created_at)
```

* Every project has its **own JWT secret**. Its anon and service keys are HS256 JWTs signed with it and carry `ref: <project>`. User access tokens issued by keel-auth also carry `ref`, so a token from one project is rejected by every other one.
* `settings` holds per-project settings: auth (site URL, redirect allow list, token lifetime, OAuth credentials, SMTP override, phone/SMS provider, MFA) and realtime (`private_only`).
* `keel.functions` stores each edge function's source files (jsonb), entrypoint, `verify_jwt` and version; `keel.function_secrets` holds their environment variables. Both notify `keel_functions` on change.
* Services keep an in-memory copy of `keel.projects` and reload it on `NOTIFY keel_projects` (a trigger on the table), so new projects and settings changes apply within a second, without restarts. keel-rest starts or restarts the matching PostgREST process.

## Roles

Created once per cluster (`server/sql/cluster/roles.sql`). Service roles log in with `POSTGRES_PASSWORD`.

| Role | Login | Used by | Notes |
|---|---|---|---|
| `postgres` | yes | Studio, migrate, backups | Superuser. |
| `authenticator` | yes | PostgREST, gateway (registry reads) | `noinherit`; switches into `anon`, `authenticated` or `service_role` per request. |
| `anon`, `authenticated` | no | API requests | Subject to row level security. |
| `service_role` | no | API requests with the service key | `bypassrls`. |
| `keel_auth_admin` | yes | keel-auth | Owns the `auth` schema. |
| `keel_storage_admin` | yes | keel-storage | Owns the `storage` schema; switches into the caller's role so storage policies apply. |
| `keel_realtime_admin` | yes | keel-realtime | `replication`; switches into subscribers' roles to check RLS. Owns the `realtime` schema. |
| `keel_functions_admin` | yes | keel-functions | Reads `keel.projects`, `keel.functions` and `keel.function_secrets`. No access to project databases. |
| `keel_egress_admin` | yes | keel-egress | Sees only project names and databases in the control database. In each project: takes requests off `net.http_request_queue` and writes `net._http_response`, nothing else. |

`PUBLIC` cannot connect to project databases or the control database; each service role is granted `CONNECT` explicitly.

## Project database layout

Applied by `server/sql/project/*.sql` and tracked in `_keel.migrations`:

* `public`: your tables. `anon`, `authenticated` and `service_role` get table privileges by default (as on Supabase); row level security decides what each caller sees.
* `extensions`: `pgcrypto`, `uuid-ossp`. Other extensions go here too. `vector` is marked trusted in keel-postgres, so the owner role can create it; `postgis` needs a superuser.
* `auth`: `users`, `identities`, `sessions` (with `aal` and `amr`), `refresh_tokens` (SHA-256 hashed), `one_time_tokens` (hashed), `flow_state` (PKCE/OAuth), `mfa_factors`, `mfa_challenges`. Column names match GoTrue so Supabase triggers and exports work. Helpers: `auth.uid()`, `auth.role()`, `auth.email()`, `auth.jwt()`.
* `storage`: `buckets`, `objects` with RLS enabled, and `storage.foldername()`, `storage.filename()`, `storage.extension()`.
* `realtime`: `messages` (RLS on; policies authorize private channels), `topic()`, `send()`, `broadcast_changes()`.
* Publication `supabase_realtime` (same name as on Supabase): tables in it stream changes.
* Event triggers: `NOTIFY pgrst, 'reload schema'` after any DDL (PostgREST picks up new tables at once), and `keel_auto_rls`, which enables RLS on new tables in `public` unless `keel.auto_rls` is `off` for the database.

## Request flow

1. A client calls `http://host:8000/recipe-box/rest/v1/recipes` with `apikey: <anon key>` and `Authorization: Bearer <user token or anon key>`.
2. keel-gateway looks up `recipe-box`, verifies the API key against that project's secret (except on open auth routes and storage, which check tokens themselves), sets `x-keel-project`, strips upstream CORS headers and adds its own.
3. REST requests go to keel-rest, which forwards to the project's PostgREST. PostgREST verifies the bearer token with the same secret and runs the query as the token's role with `request.jwt.claims` set, so `auth.uid()` works in policies.
4. Auth, storage and realtime requests go to the shared services, which pick the project from `x-keel-project` and verify tokens with that project's secret.

## Auth details

* Passwords: bcrypt (cost 10), compatible with Supabase exports.
* Access tokens: HS256, default lifetime 3600 s, claims as GoTrue (`sub`, `role`, `aud`, `email`, `app_metadata`, `user_metadata`, `session_id`, `amr`, `aal`, `is_anonymous`) plus `ref`.
* Refresh tokens rotate on every use. A rotated token can be reused for 10 seconds (two tabs refreshing at once); after that, reuse revokes the whole session.
* Email links and codes: a 6-digit code per email; links carry an HMAC of (email, code) keyed with the project's secret, so a hash can't be computed from a guessed code. They expire after an hour and work once. Without SMTP they are written to the log.
* An account that was never confirmed loses any password when its owner proves the address by magic link, invite, recovery or OAuth, so nobody can pre-register someone else's email and keep access.
* Rate limits use the address keel-gateway appends to `X-Forwarded-For` (client-supplied entries are ignored); email codes are also limited per address.
* Phone numbers are stored like GoTrue does (digits, no `+`). SMS codes are stored as a keyed HMAC of (phone, code), can only be checked as phone + code (never as a hash), expire after 60 seconds by default, and are limited per number (sending and guessing) and per project (sending). Test numbers use a fixed code and never reach a provider.
* MFA: TOTP secrets are 160-bit (RFC 6238, SHA-1, 6 digits, ±1 step); a code's time step can't be used twice. Verifying a factor upgrades the session to `aal2` and issues new tokens; refreshes keep the session's level. With a verified factor, enrolling another factor, removing a verified one, or changing email, phone or password needs an `aal2` session. Phone factor codes are stored as `sha256(challenge id + code)`.
* Redirects (`redirect_to`) must match the site URL's origin or an allow-list entry, otherwise the site URL is used. Allow-list wildcards are matched per URL part, so they never spill from the path into the host.

## Storage details

* Bytes live at `<volume>/<database>/<bucket>/<object id>/<version>`. Paths come from ids, never from object names, so names cannot escape the volume. Overwrites write a new version file and delete the old one after the database commit.
* Every operation that touches `storage.objects` or `storage.buckets` runs inside a transaction as the caller's role, so Supabase-style storage policies apply. Public downloads and signed URLs read metadata as the storage role after checking the bucket is public or the signature is valid.
* Signed URLs are JWTs (project secret) scoped to one object (`url` claim) and kind (`storage-sign` or `storage-upload`).
* Resumable uploads (TUS 1.0.0, `creation`, `creation-with-upload`, `termination`, `expiration`) keep partial files in `<volume>/<database>/.uploads/` with a JSON sidecar recording the bucket, name and uploader. Every request must carry a token for the same user; storage policies are checked with a rolled-back trial insert when the upload is created, and again (for real) when the last byte arrives. Unfinished uploads expire after 24 hours.
* Image transforms are signed imgproxy URLs (`IMGPROXY_KEY`/`IMGPROXY_SALT`) for `local://` paths on the shared volume.

## Realtime details

* One temporary logical replication slot per project, created when the first `postgres_changes` subscriber joins and dropped about a minute after the last one leaves. Temporary slots disappear if the connection drops, so a stopped Keel never makes Postgres keep WAL around.
* Changes are decoded from the built-in `pgoutput` plugin, so no extension is needed.
* For each change and subscriber: tables without RLS are delivered if the subscriber's role can `SELECT` the table; inserts and updates on tables with RLS are checked by selecting the row by primary key as the subscriber (with their JWT claims). A deleted row can't be selected, so for deletes the table's SELECT policies are evaluated against the old row instead. That needs `REPLICA IDENTITY FULL` (Studio sets it when you turn on Realtime); without it, delete events on RLS tables are not sent.
* Private channels: on join, keel-realtime inserts probe rows into `realtime.messages` inside a transaction that is always rolled back, then checks as the subscriber (JWT claims and `realtime.topic` set) which rows are visible (read) and whether an insert is allowed (write), separately for broadcast and presence. The result is rechecked when the client sends a new token. Public and private channels with the same name are separate rooms.
* Broadcast from the database: an insert into `realtime.messages` fires `NOTIFY keel_realtime_messages` with the row id; keel-realtime keeps one listening connection per project with open channels, reads the row and delivers it to the matching room. Rows older than a day are deleted hourly.
* Wire protocol: Phoenix channels with serializer 1.0.0 (JSON objects) and 2.0.0 (JSON arrays plus binary broadcast frames), matching `@supabase/realtime-js`. Channels close when the subscriber's token expires.

## Backups

Studio runs `pg_dump --format=custom` per project into the `keel-backups` volume (`<project>/<project>-<timestamp>.dump`) daily at `KEEL_BACKUP_SCHEDULE` (or the time set in Studio, `keel.backup_settings`), keeping `KEEL_BACKUP_RETENTION` nightly dumps. Restores use `pg_restore --clean --if-exists --single-transaction`, so a failed restore leaves the database unchanged.

With `KEEL_BACKUP_PASSPHRASE` set, the nightly run then writes a **full backup** (`server/src/lib/backupset.ts`) to `backups/full/keel-<time>.tar.age`: a tar stream of `manifest.json`, `db/<database>.dump` for the control database (without `keel.studio_sessions` rows) and every project database, and `storage/...` (Studio mounts the storage volume read-only; `.uploads` is skipped), encrypted on the fly in the age v1 format (scrypt passphrase stanza, ChaCha20-Poly1305 STREAM, `server/src/lib/age.ts`). Databases are dumped before files are copied. Progress and results are rows in `keel.backup_sets`. The file is then uploaded to an S3-compatible target (`server/src/lib/s3.ts`, SigV4 over fetch, 16 MiB multipart parts read from disk) set in `.env` (`KEEL_BACKUP_S3_*`) or in Studio (`keel.backup_settings`, readable only by the superuser; the secret key sealed with AES-256-GCM under `deriveSecret(KEEL_SECRET, 'backup-target')`). Retention in the target keeps the newest set of each of the last N days and M ISO weeks and only deletes names matching `keel-YYYYMMDD-HHMMSS.tar.age`; locally the newest `KEEL_BACKUP_KEEP_LOCAL` stay.

`./keel restore` runs `keel restore` in a one-off keel-migrate container (which mounts the storage and backups volumes) with the other services stopped: it downloads the set if needed, decrypts and reads all of it once (`--verify-only`), then reads it again to create missing roles (no login, no passwords), drop and `pg_restore --create` each database, drop project databases the backup doesn't have, empty the storage folder and write the files (paths checked to stay inside it). keel-migrate then runs as on every start: schema upgrades for an older backup, owner role logins from `keel.project_owners`.

## Scheduled jobs and outgoing requests

`pg_cron` and `pg_net` run their background worker in one database per server, and every Keel project is a database, so neither extension is used. Instead, `server/sql/project/013_cron_and_net.sql` gives each project their SQL API (`cron.schedule`, `cron.job`, `cron.job_run_details`, `net.http_*`, `net.http_request_queue`, `net._http_response`, `supabase_functions.http_request`), usable only by the owner role and superusers. keel-studio runs the jobs (`server/src/studio/scheduler.ts`) and keel-egress sends the requests (`server/src/egress/index.ts`):

* Every second it reads each project's active jobs (reloaded every 5 s) and starts the due ones: five-field schedules when their minute starts (UTC), `N seconds` jobs when their interval has passed. Each run opens a connection of its own as `<db>_owner` (password from `keel.project_owners`), never as a superuser, so a job can't `reset role` its way up. One run per job at a time, `KEEL_CRON_MAX_RUNNING` per project, and the backend is terminated after `KEEL_CRON_TIMEOUT`. Runs left `running` by a restart are marked failed. The scheduler's own queries use a separate pool with `lock_timeout` 5 s and `statement_timeout` 15 s (the owner role can lock cron's tables), and each project is ticked on its own.
* keel-egress logs in as `keel_egress_admin` (no superuser password, not on the Docker proxy's network) and, every second per project, takes up to `KEEL_NET_CONCURRENCY` queued requests off `net.http_request_queue` (deleted when taken, so each is sent at most once; listed in `net._keel_sending` until answered, so a request cut off by a restart gets an error response when keel-egress starts again). Nothing is taken when the address policy can't be built. It sends them with `server/src/lib/egress.ts`: http/https only, every resolved address checked against the edge functions' private ranges (plus IPv6 ranges, which Deno can't express), this container's addresses and networks, Keel's services, `KEEL_FUNCTIONS_DENY_NET` and `KEEL_HOST_ADDRESSES`, with `KEEL_FUNCTIONS_ALLOW_LAN` opening LAN blocks; the connection is pinned to the checked address, redirects aren't followed, responses are capped. URLs for the project's own `/functions/v1/` (under the public URL or `http://keel-gateway:8000`) go to the gateway directly.
* A webhook trigger (`supabase_functions.http_request`, 014_egress.sql) skips its request with a warning when the queue holds 10,000 requests, rather than failing the write that fired it.
* Commands, request bodies and headers are never logged. Run history and responses are pruned every minute.

## Edge functions

* keel-gateway forwards `/<project>/functions/v1/<name>/...` to keel-functions, which checks the JWT (unless `verify_jwt` is off), then proxies to the function's process over a unix socket. The function sees the path `/<name>/...`, like on Supabase.
* On first use the function's files are written to `<volume>/code/<project>/<name>/v<version>/` and a Deno process starts with `server/runtime/bootstrap.js`, which loads the entrypoint, captures the handler passed to `Deno.serve` (or a default export's `fetch`) and serves it on the socket. Deno's module cache (`npm:`, `jsr:`, URL imports) is shared in `<volume>/cache`.
* Permissions: network, environment, system info and imports; reading only its own code, its temp folder and the module cache; writing only its temp folder. No subprocesses, no FFI. The environment contains only the project's secrets, `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` (pointing at the internal gateway) and proxy settings.
* Network: `--allow-net` with every private and special IPv4 range, `::`, `::1`, the container's own addresses and the server's public address in `--deny-net` (`server/src/functions/sandbox.ts`). Deno 2.9 checks address rules against the resolved address of each connection, so aliases don't get through; it has no syntax for IPv6 ranges. `SUPABASE_URL` requests go through a per-function Unix socket that keel-functions forwards to the gateway, for that project only; `bootstrap.js` routes `fetch` and `WebSocket` for that origin through it with `Deno.createHttpClient({ proxy: { transport: 'unix' } })`.
* Processes stop after `KEEL_FUNCTIONS_IDLE` seconds without requests, when a new version or new secrets arrive (after requests in flight finish), or to stay under `KEEL_FUNCTIONS_MAX_WORKERS`. Console output and recent requests are kept in memory for Studio; internal endpoints (`/_keel/*`) need `KEEL_FUNCTIONS_TOKEN` (or a token derived from the service password; keel-functions never gets `KEEL_SECRET`) and can't be reached through the gateway.

## Importer

`server/src/importer/supabase.ts` copies a Supabase (or Keel) project into a Keel project. It treats the source as untrusted:

* Auth users, identities, MFA factors, buckets and object metadata are copied row by row with parameters (columns both sides have).
* Schemas are restored with `pg_dump`/`pg_restore` by a dedicated role, `keel_import_<db>`: not a superuser, allowed to create objects in the project database and to read/reference `auth` and `storage` tables. It owns the imported objects, so `SECURITY DEFINER` functions and expressions from the source run with its rights, never the superuser's. It can only log in while an import runs.
* Triggers on `auth.users` and policies on `storage.*`/`realtime.messages` are recreated as those tables' (non-superuser) owners, one statement at a time.
* Only a list of common contrib extensions is created; the source's catalog is queried with `search_path=pg_catalog`.
