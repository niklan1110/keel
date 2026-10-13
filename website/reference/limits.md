# Limits

Keel has no usage quotas or bills: how much you can store and serve depends on your hardware. It does have limits that protect the server and your users, such as upload sizes, time limits and rate limits. This page lists all of them, with their defaults and how to change them.

Settings in `.env` take effect after `./keel up`. "Fixed" means the value is built into Keel. "Compose file" means you change the service's settings in Docker Compose, in a `docker-compose.override.yml` next to `docker-compose.yml`, so updates don't conflict with your changes (see [Configuration](/self-hosting/configuration#advanced)).

## Projects

| Limit | Value | How to change |
|---|---|---|
| Project name | 3 to 40 characters: lowercase letters, digits and dashes, starting with a letter and ending with a letter or digit, no `--` | Fixed |
| Reserved project names | `api`, `auth`, `rest`, `storage`, `realtime`, `functions`, `studio`, `health`, `keel`, `postgres`, `template0`, `template1`, `admin`, `assets`, `static`, `graphql`, `docs` | Fixed |
| Projects per server | No set limit. Each project runs its own PostgREST process and uses database connections, so memory and `max_connections` are the practical limits. | |
| API key lifetime | 10 years from when the project was created | Fixed |

## Database

| Limit | Default | How to change |
|---|---|---|
| Postgres `max_connections` | 100 (Postgres's default) | `alter system set max_connections = 200;`, then restart the stack (see [Connecting directly](/database/connecting-directly#connections-and-pooling)) |
| Statement timeout for API requests | 3 s as `anon`, 8 s as `authenticated` | Fixed (re-applied on every start) |
| Rows per REST response | 1,000. Use `.range()` or `limit`/`offset` to page through more. | Per project: `max_rows` in the project's settings (see [Exposing other schemas](/database/overview#exposing-other-schemas)). For every project: compose file, `KEEL_POSTGREST_MAX_ROWS` in the `keel-rest` service's environment |
| Logical replication slots and senders | 32 each. Realtime uses one slot per project that has database-change subscribers. | Compose file: `max_replication_slots` and `max_wal_senders` in the `keel-db` command |
| Slow query log threshold | 200 ms | `KEEL_SLOW_QUERY_MS` (`-1` turns it off) |

Each project's services open database connections as they need them: PostgREST up to 10, auth and storage up to 10 each, and a few more for realtime and Studio. With many busy projects, raise `max_connections` and make sure the server has the memory for it.

## Studio

| Limit | Value | How to change |
|---|---|---|
| Session length | 12 hours | Fixed |
| Failed sign-in attempts | 10 per address per 15 minutes (a successful sign-in resets the count); 20 per account per hour from the internet | Fixed |
| SQL editor statement timeout | 60 seconds | Fixed |
| SQL editor result rows shown | 1,000 per statement | Fixed |
| SQL per run | 2 MB | Fixed |
| Table browser | 50 rows per page, 15-second query timeout | Fixed |
| Users list | First 100 users matching the search | Fixed |
| Files list | 1,000 entries per folder | Fixed |
| Backup download links | Valid for 1 minute, only in the Studio session that made them | Fixed |
| Minimum secret lengths in `.env` | `KEEL_SECRET` 32, `POSTGRES_PASSWORD` 12, `KEEL_DASHBOARD_PASSWORD` 8 characters | Fixed |

## Backups

| Limit | Default | How to change |
|---|---|---|
| Nightly backup time | 03:00 (container time zone, `TZ`) | `KEEL_BACKUP_SCHEDULE` (`HH:MM`, or `off`) |
| Nightly backups kept per project | 7 | `KEEL_BACKUP_RETENTION` |
| Manual backups | Kept until you delete them | |
| Full backups kept on the server | 2 | `KEEL_BACKUP_KEEP_LOCAL` |
| Full backups kept in the backup target | Newest of each of the last 7 days and 4 weeks | Studio, **Backups** > **Schedule** |
| Backup passphrase | 12 characters or more | |
| Backups listed in Studio | The latest 100 per project | Fixed |

## Auth

| Limit | Default | How to change |
|---|---|---|
| Access token (JWT) lifetime | 3,600 s (1 hour) | Studio: **Users**, **Sign-in settings**, **Session token lifetime** (60 s to 7 days) |
| Reuse window for a rotated refresh token | 10 seconds | Fixed |
| Password length | At least 6 characters, at most 72 | Minimum: **Sign-in settings**, **Minimum password length** (6 to 72) |
| Email links and codes | 6-digit code, valid for 1 hour, single use | Fixed |
| Time between emails to one address | 60 seconds (per kind of email) | Fixed |
| Emails per address | 6 per hour | Fixed |
| Password sign-in attempts | 10 per 5 minutes per IP address and email (or phone) | Fixed |
| Wrong passwords per account | 20 per hour from all addresses together; after that each attempt waits twice as long as the one before, up to 5 minutes. Addresses that signed in to the account in the last 30 days aren't held up, so someone guessing can't lock the owner out. | Fixed |
| Password checks at once | 4 for the whole `keel-auth` service; up to 64 more wait at most 2 seconds, the rest get `503` (`request_timeout`) | Fixed |
| Token requests (sign-in and refresh) | 120 per 5 minutes per IP address | Fixed |
| Link and code verifications | 30 per 5 minutes per IP address, and 10 code guesses per hour per email or phone | Fixed |
| SMS code lifetime | 60 seconds | **Sign-in settings**, **Code expires after** (30 to 3,600 s) |
| SMS code length | 6 digits | **Sign-in settings**, **Code length** (6 to 10) |
| SMS sending | 60 seconds between codes to one number; 6 per hour per number; 10 per hour per IP address; 60 per hour per project | Fixed. Test numbers are exempt. |
| MFA factors per user | 10 | Fixed |
| MFA challenge lifetime | 5 minutes | Fixed |
| MFA verification attempts | 10 per 5 minutes per user | Fixed |
| SMS second-factor codes | One every 15 seconds | Fixed |
| PKCE auth code and OAuth state | 10 minutes | Fixed |
| Users per page in the admin API | 50 by default, up to 1,000 (`per_page`) | Per request |
| JSON request body | 1 MB | Fixed |

All auth limits apply per project. Limits "per IP address" use the address that connects to `keel-gateway`; addresses that clients put in `X-Forwarded-For` are ignored. Behind a reverse proxy on the same machine (Caddy, nginx, `tailscale serve`), that address is the proxy's, so all users behind it share those limits.

## Storage

| Limit | Default | How to change |
|---|---|---|
| Largest upload | 500 MB (524,288,000 bytes) with the installer and on ZimaOS, 50 MB (52,428,800 bytes) when built from source; for regular and resumable uploads | `KEEL_STORAGE_MAX_FILE_SIZE` (bytes) |
| Bucket file size limit | None (the server-wide limit applies) | Per bucket, in Studio or with `updateBucket`. It can only lower the server-wide limit. |
| Bucket name | 1 to 100 characters: letters, digits, spaces, `.`, `_` and `-`, starting with a letter or digit | Fixed |
| Reserved bucket names | `public`, `authenticated`, `sign`, `info`, `list`, `move`, `copy`, `upload`, `render` | Fixed |
| Object name | Up to 1,024 characters; no leading `/`, no `.` or `..` segments, no backslashes | Fixed |
| Objects per list request | 100 by default, up to 1,000 | Per request (`limit`) |
| Signed download URLs | Valid for the `expiresIn` you pass | Per request |
| Signed upload URLs | Valid for 2 hours | Fixed |
| Resumable uploads (TUS) | Any chunk size; unfinished uploads are deleted after 24 hours; `Upload-Defer-Length` isn't supported | Fixed |
| Image transformations | Width and height 1 to 2,500 px, quality 20 to 100 (default 80), source images up to 50 megapixels | Fixed |

## Realtime

| Limit | Value | How to change |
|---|---|---|
| WebSocket message size | 1 MB (a bigger message closes the connection) | Fixed |
| Messages per connection | 100 per second, with bursts of up to 200. Extra messages are refused with `RateLimitReached`; a client that keeps flooding is disconnected. | Fixed |
| Messages waiting to be handled per connection | 500, or 8 MB | Fixed |
| Unread data per connection | 16 MB queued for a client that doesn't read; then it's disconnected | Fixed |
| Channels per connection | 100 | Fixed |
| `postgres_changes` listeners per channel | 100 (a join asking for more is refused with `TooManyBindings`) | Fixed |
| Topic (`realtime:` plus the channel name) | 255 bytes, no control characters | Fixed |
| Presence state | 64 KB per tracked entry (key and state as JSON) | Fixed |
| Presence entries per connection | One per channel, on up to 10 channels at once | Fixed |
| HTTP broadcast request body | 1 MB | Fixed |
| HTTP broadcast messages | 100 per request, for at most 20 different private topics | Fixed |
| Filters per `postgres_changes` listener | 1 | Fixed |
| Channel lifetime | Until the user's access token expires (checked every 15 seconds), unless the client sends a fresh token | Fixed |
| Database-change streaming | Starts with the first subscriber in a project and stops about a minute after the last one leaves | Fixed |
| Messages in `realtime.messages` | Deleted after 24 hours | Fixed |
| Connections per client address | 200 per project (an IPv6 client counts per `/64`); more get `429` | `KEEL_REALTIME_MAX_PER_IP` |
| Anonymous connections per project | 10,000 sockets that haven't joined a channel with a user's token. Past that, a new socket is let in but closed after 10 seconds unless it joins a channel with a user's token. Signed-in users and the service role key are not counted. | `KEEL_REALTIME_MAX_PER_PROJECT` |

## Edge functions

| Limit | Default | How to change |
|---|---|---|
| Memory per function | 256 MB | `KEEL_FUNCTIONS_MEMORY_MB` |
| Time per request | 150 seconds (then `504` with `WORKER_TIMEOUT`) | `KEEL_FUNCTIONS_TIMEOUT` (seconds) |
| Idle time before a function's process stops | 300 seconds | `KEEL_FUNCTIONS_IDLE` (seconds) |
| Functions running at once, across all projects | 20. At the limit, the function that has been idle longest is stopped to make room. | `KEEL_FUNCTIONS_MAX_WORKERS` |
| Startup time | 90 seconds, including downloading `npm:` and `jsr:` packages on first use | `KEEL_FUNCTIONS_BOOT_TIMEOUT` (seconds) |
| Function name | 1 to 63 characters: letters, digits, `-` and `_`, starting with a letter | Fixed |
| Source per function | 20 MB and 500 files in total; paths up to 300 characters | Fixed |
| Single file when deploying from the CLI or a Studio folder upload | 5 MB, text only (binary files are skipped) | Fixed |
| Secret names | Up to 128 letters, digits and underscores, not starting with a digit. Names Keel sets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `KEEL_*`, `DENO_*` and a few system variables) are reserved. | Fixed |
| Logs kept for Studio | The last 1,000 console lines and 200 requests per function, until `keel-functions` restarts | Fixed |

See [Runtime and limits](/functions/runtime) for what functions can and can't do.

## Scheduled jobs and outgoing requests

| Limit | Default | How to change |
|---|---|---|
| Time per cron run | 300 seconds, then the run is stopped and marked `failed` | `KEEL_CRON_TIMEOUT` (seconds) |
| Cron jobs of one project running at once | 4. A job due while at the limit runs at its next turn. | `KEEL_CRON_MAX_RUNNING` |
| Cron run history (`cron.job_run_details`) | 7 days | `KEEL_CRON_HISTORY_DAYS` |
| Shortest cron interval | 1 second (`'1 seconds'`) | Fixed |
| Active cron jobs per project | 1,000; jobs past that don't run (a warning is logged) | Fixed |
| Size of a cron job's command | 1 MB | Fixed |
| Time per HTTP request (`net.http_*`, webhooks) | 60 seconds, or less with `timeout_milliseconds` | `KEEL_NET_MAX_TIMEOUT_MS` |
| HTTP response kept | 1 MB; larger responses fail | `KEEL_NET_MAX_RESPONSE_BYTES` |
| HTTP requests of one project in flight at once | 8 | `KEEL_NET_CONCURRENCY` |
| HTTP requests waiting to be sent, per project | 10,000; further `net.http_*` calls raise an error, and webhooks skip the request with a warning | Fixed |
| Size of an HTTP request | URL 32 KB, headers 64 KB, body 5 MB; larger requests raise an error | Fixed |
| HTTP responses kept (`net._http_response`) | 6 hours | `KEEL_NET_TTL_HOURS` |

### Database connections

Each cron run opens a database connection of its own (as the project's owner role) and closes it when the run ends, as `pg_cron` does by default. At most `KEEL_CRON_MAX_RUNNING` runs per project are open at once, so with the defaults cron can hold up to 4 connections per project, on top of about 3 for the scheduler itself and 3 for `keel-egress` per project with queued requests.

Postgres allows 100 connections in all (`max_connections`), shared by every project's PostgREST pool, auth, storage, realtime, Studio and your own clients. On a server with many projects or busy jobs, keep `KEEL_CRON_MAX_RUNNING` low, or raise `max_connections` with `KEEL_DB_SETTINGS="max_connections=200"` (each connection takes a few MB of memory). When Postgres is out of connections, a run fails with `sorry, too many clients already` in `cron.job_run_details`.

See [Scheduled jobs](/database/cron) and [Database webhooks](/database/webhooks).
