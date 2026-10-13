# Changelog

All notable changes to Keel are written down here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Keel uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor
version (0.2 → 0.3) may change behaviour; the notes say what to look out for.

Each release's notes on GitHub are taken from its section below.

## [Unreleased]

## [0.3.2] - 2026-10-13

A security release from a full review of 0.3.0. Update every install.

### Changed

- Keel is licensed under the Functional Source License (FSL-1.1-ALv2). Using,
  changing and running Keel, including inside a company, is free; selling it
  or offering it as a competing product or hosted service needs permission.
  Each release becomes Apache 2.0 two years after it comes out.

### Security

- A project's owner role could make the Postgres superuser run its own code:
  through the scheduler's nightly cleanup, the event triggers that turn on
  row level security for new tables, and the Studio table editor. Superuser
  connections now use `search_path=pg_catalog`, the trigger functions have a
  fixed search path (migration 015), and the table editor works as the owner
  role.
- Edge functions could reach private addresses through `import()`, which
  `--deny-net` doesn't cover. Module imports now follow the same address
  rules as `fetch`.
- Function secrets can no longer set runtime variables that change how Deno
  or npm behave, such as `SSLKEYLOGFILE`, `NPM_CONFIG_*` or `GLIBC_TUNABLES`.
- A realtime channel takes at most 100 `postgres_changes` bindings, so one
  join can no longer stall realtime for every project.
- Signed URLs need a numeric expiry, and `install.sh` makes the install folder
  readable by its owner only.
- Default-branch builds no longer publish the branch name as an image tag.

## 0.3.0 - 2026-10-12

Postgres extensions, scheduled jobs and webhooks, more sign-in providers,
encrypted off-site backups and installers for Windows, macOS and NAS systems.
Read "Upgrading" before you update an existing install.

### Upgrading

- `keel-db` runs a new image, `keel-postgres`: the same Postgres 17 as before
  with pgvector and PostGIS added, so existing data is used as it is. It comes
  with the new compose file: run the installer again to switch (a plain
  `./keel update` keeps the old compose file and image). On ZimaOS, change
  `keel-db`'s image to `ghcr.io/<owner>/keel-postgres:latest`. A third package
  is published next to `keel` and `keel-functions`; make it public too if you
  publish your own images.
- The compose files have a new service, `keel-egress`, and a new network.
  With the installer's compose file, `./keel up` (or `docker compose up -d`)
  starts it; on ZimaOS, import the new compose file.

### Added

- Sign-in with any OpenID Connect provider, such as Authentik, Keycloak,
  Authelia, Pocket ID or Zitadel: add one or more per project in Studio
  (**Users > Sign-in settings**) and sign in with
  `signInWithOAuth({ provider: 'custom:<id>' })`, as in Supabase. Keel uses
  discovery, PKCE and a nonce, and checks the provider's signed ID token.
  A provider on your own network can be reached over plain http when you
  allow it for that provider.
- Sign-in with Discord, GitLab (gitlab.com or your own) and Microsoft
  (`azure`).
- pgvector 0.8.7: `create extension vector with schema extensions`, vector
  columns, HNSW and IVFFlat indexes and nearest-neighbour search through RPC,
  as in Supabase's guides. A project's owner role can enable it.
- PostGIS 3.6.4 (without raster): `geometry` and `geography`, spatial indexes
  and `.geojson()` responses. Enabled by the superuser in Studio's SQL editor.
- The Supabase importer recreates `vector` and `postgis`.
- Docs: a page on extensions.
- Scheduled jobs with `pg_cron`'s SQL API in every project: `cron.schedule`
  (five-field schedules, `$`, `@daily` and friends, or `'N seconds'`),
  `cron.unschedule`, `cron.alter_job`, `cron.job` and `cron.job_run_details`.
  Jobs run as the project's owner role, never as a superuser, one run at a
  time, stopped after `KEEL_CRON_TIMEOUT`. keel-studio runs them.
- HTTP requests from SQL with `pg_net`'s API: `net.http_get`, `net.http_post`,
  `net.http_delete` and `net._http_response`, and Supabase's Database Webhooks
  (`supabase_functions.http_request` triggers). Calls to the project's own
  edge functions are routed inside Keel. A full queue skips a webhook's
  request instead of failing the write that fired it.
- `keel-egress`, a new container that sends those requests. It logs in as
  `keel_egress_admin`, which can only work the request queues, and sits on a
  network of its own with the database and the gateway.
- Studio: a **Jobs** tool listing scheduled jobs, recent runs and outgoing
  requests.
- A Windows installer, `install.ps1`, for Docker Desktop in Windows PowerShell
  5.1 or PowerShell 7: no WSL terminal or Git Bash needed. It installs one
  exact version into `%USERPROFILE%\keel`, writes `.env` with random
  passwords (readable by your account only), keeps Studio and Postgres on the
  PC unless you pass `-Lan` / `-LanDb`, waits until Keel answers and prints
  your login. Running it again updates (with a database backup first);
  `-Rollback` goes back. `-DryRun` shows what it would do.
- A Windows `keel` command (`keel.cmd`) with the same commands as the bash one,
  including `update` and `rollback` with the same backups, so either can roll
  back the other's update.
- On Windows, Postgres keeps its data in a Docker volume
  (`docker-compose.windows.yml`) instead of on the Windows drive, where it is
  several times slower.
- Install guides for Windows, macOS (Docker Desktop, OrbStack, Colima),
  Unraid, TrueNAS SCALE and Synology.
- `nas-docker-compose.yml`, the self-contained compose file for NAS app
  screens (Unraid's Compose Manager, TrueNAS's Install via YAML, Synology's
  Container Manager, Portainer). It is the ZimaOS file under a second name.
- `KEEL_PUBLIC_NETWORK` names the network a tunnel or Traefik joins, so a
  second Keel on the same machine no longer shares the first one's
  `keel-public` network.
- Full backups: with `KEEL_BACKUP_PASSPHRASE` set, Keel writes one file each
  night holding every project's database, Keel's own settings, keys and Studio
  accounts, and every uploaded file, encrypted with the passphrase in the age
  format (open it with Keel or with the `age` tool). The newest
  `KEEL_BACKUP_KEEP_LOCAL` (2) stay on the server.
- Off-site copies: full backups are uploaded to an S3-compatible bucket (AWS
  S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO...), set up in Studio or with
  `KEEL_BACKUP_S3_*` in `.env`. The bucket keeps the newest backup of each of
  the last 7 days and 4 weeks. Uploads go in parts, so a NAS with 1 GB of RAM
  can upload backups of any size.
- `./keel restore` brings a whole install back from a full backup, on the same
  machine or a fresh install elsewhere, from a file or straight from the
  bucket. It checks the passphrase and the whole file before changing
  anything. `./keel restore --list` shows the backups.
- Studio's Backups drawer has the backup schedule, the retention, the backup
  target with a connection test, full backups with their upload state, and the
  backups in the bucket.
- `.\keel restore` on Windows, with the same checks and confirmation as the
  bash `keel`.
- Studio's Postgres connection strings (Connect, the agent prompt's
  `KEEL_DB_URL`) ask for TLS with `?sslmode=require` when Postgres has it.
- A new landing page and a restyled documentation site: one sidebar in
  reading order, a quickstart per platform, Coming from Supabase, a glossary,
  an FAQ, more troubleshooting, image zoom and better search.

### Security

- Requests from SQL follow the edge functions' network rules: private, LAN,
  loopback and metadata addresses (IPv4 and IPv6), this server and Keel's
  containers are refused unless opened with `KEEL_FUNCTIONS_ALLOW_LAN`; every
  address a name resolves to is checked and the connection is pinned to it;
  redirects aren't followed. Only the project owner role and superusers can
  schedule jobs or send requests; the API roles can't reach the `cron` and
  `net` schemas. The sender has no superuser password and no route to
  Studio or the Docker socket proxy.
- Both installers check every file they download (compose files, the `keel`
  command) against the published `SHA256SUMS` and stop before changing
  anything when one doesn't match.
- Keel's own CLI (`fn deploy`, `secrets`) follows the `sslmode` in
  `KEEL_DB_URL` like libpq (`require`, `verify-ca`, `verify-full`, `disable`);
  before, it never used TLS from another machine. A repeated `sslmode` is
  refused. The docs recommend `verify-ca` with the server's certificate.
- cloudflared 2026.10.0, the Dockerfile frontend pinned by digest, and the
  `keel-functions` image takes Debian's security updates at build time.

### Changed

- Sign-in provider secrets are encrypted in the project settings when you
  save them. Secrets saved before stay as they are until you enter them again.
- `GET /auth/v1/settings` lists the new providers under `external`.
- The database image no longer contains gosu (a Go binary); its entrypoint
  drops root with Alpine's su-exec, and it gets Alpine's security updates at
  build time.
- Releases now include `install.ps1` with `install.ps1.sha256`, the Windows
  `keel` command, `docker-compose.windows.yml` and `nas-docker-compose.yml`.
- CI runs the installers end to end on Linux, on macOS with its bash 3.2, and
  on Windows PowerShell 5.1, runs PSScriptAnalyzer, and checks that the main,
  source and NAS compose files define the same services and pinned images.
- Studio mounts the storage folder (read-only) to back up uploaded files, and
  keel-migrate mounts the storage and backups volumes in a source checkout,
  for `./keel restore`. Installer installs get the new compose file and
  `keel` script by running the installer again; on ZimaOS, import the new
  compose file. Without it, a full backup of a project with uploaded files
  fails with a message saying so, rather than leaving the files out.
- The nightly backup time can be changed in Studio; it wins over
  `KEEL_BACKUP_SCHEDULE`.

### Fixed

- A failed sign-in with a provider redirects back to the app with 302, as
  Supabase does, instead of 303.
- Docs: Studio API examples use the cookie session (the bearer-token
  examples got 401), Postgres TLS and bind defaults are described correctly,
  and the owner role is no longer said to bypass row level security.

## 0.2.0 - 2026-10-12

A security release. Read "Upgrading" before you update an existing install.

### Upgrading

- Studio keeps its session in a cookie now, so everyone signs in to Studio
  again once.
- Studio and Postgres listen on the machine itself. To reach Studio from your
  network, set `KEEL_STUDIO_BIND=0.0.0.0` (or run `./keel init --lan` on a new
  install); behind Caddy, nginx or another proxy on the same machine, add its
  host name to `KEEL_STUDIO_HOSTS`.
- Postgres refuses the `postgres` superuser from other machines. Connect as
  the project owner role (Studio, Connect) or set
  `KEEL_DB_REMOTE_SUPERUSER=on`; other machines need TLS.
- Behind your own reverse proxy, list it in `KEEL_TRUSTED_PROXIES` so
  visitor addresses are counted correctly.
- On ZimaOS, import the new compose file from this release.

### Security

- Visitor addresses are taken from `X-Forwarded-For` only when Keel's own
  proxies (the gateway, the Cloudflare tunnel) or a proxy listed in the new
  `KEEL_TRUSTED_PROXIES` forwarded the request. A forged header no longer
  counts as "local" (which skipped two-factor for Studio and raised the auth
  limits) or changes the rate-limit key. IPv6 clients are counted per /64.
- Studio answers local requests only for known host names (IP addresses,
  `localhost`, local names, the public addresses, `KEEL_STUDIO_HOSTS`), which
  stops DNS-rebinding attacks from browsers on the local network.
- Studio and Postgres listen on the machine itself by default; `--lan` and
  `--lan-db` open them. Postgres requires TLS (a self-signed certificate is
  made on first start) and a password from other machines, and refuses the
  `postgres` superuser from them unless `KEEL_DB_REMOTE_SUPERUSER=on`.
- Edge functions can no longer reach private addresses (the Docker host, the
  LAN, Keel's containers); they reach their own project's API through a
  socket. `KEEL_FUNCTIONS_ALLOW_LAN` opens chosen LAN addresses, such as a
  local Ollama.
- Password sign-ins are limited per account across all addresses, and new
  projects require passwords of at least 8 characters.
- Request bodies that stall are closed (`KEEL_BODY_IDLE_TIMEOUT`), and open
  connections and realtime sockets per client and project are capped.
- Sign-in links, codes, email addresses and phone numbers are kept out of
  the logs (`KEEL_LOG_PII=on` shows the personal data for debugging). Postgres
  error text that names tables and constraints is no longer sent to API
  clients.
- App users' TOTP secrets are encrypted at rest; new passwords use bcrypt cost
  12. Studio sessions, two-factor secrets, backup download links and the
  functions service each use their own key derived from `KEEL_SECRET`.
  Backup download links only work for the Studio session that made them.
- Sessions that expired or were unused for 90 days are deleted, with the IP
  addresses and browsers they store.
- New projects on a public server don't start with open, auto-confirmed
  sign-ups. Passwords that appeared as examples in the docs are refused.
- Every service role has its own database password, and services read only
  the project columns they use. Keel's service roles and the superuser can't
  sign in from outside its containers.
- Studio keeps its session in an HttpOnly cookie and refuses cross-site
  calls.
- Project owner roles don't bypass row level security, so one project's owner
  can't see another project's functions or secrets.
- Containers are hardened: read-only root filesystems where possible, no
  capabilities for migrations, and image-resize requests are signed on ZimaOS
  too.

### Added

- API keys can be rolled, stopped and emergency-rolled from Studio's Connect
  page and `./keel keys`. Tokens carry a key id, and the old key keeps working
  until you stop it.
- A project owner role for each project, for developers and coding agents
  that need to change the schema; Studio Connect and the agent prompt use it.
- Releases: version tags (`v*`) publish the `X.Y.Z`, `X.Y`, `X` (from 1.0) and
  `latest` image tags and a GitHub release with these notes; pushes to the
  default branch publish `edge`. Images are published only after CI passes.
- Images carry their version, source and commit as OCI labels, an SBOM and
  build provenance, are signed with cosign (keyless), and are scanned for
  critical vulnerabilities before they are published.
- `./keel update` backs up every database before it changes anything, moves
  between version numbers and remembers the previous one; `./keel rollback`
  goes back, and restores the backup when the newer version upgraded the
  schema. The installer does the same, with `--rollback` and `--restore`.
- `keel-migrate` refuses to start an image older than the database.
- Studio shows the running version and, once a day at most, whether a newer
  release exists (`KEEL_UPDATE_CHECK=off` turns that off).
- The installer comes with a SHA-256 checksum, and each GitHub release has its
  own installer that installs exactly that version.
- Health checks on every service, and `docker-compose.small.yml` for a
  Raspberry Pi or a NAS with 1-2 GB of RAM (`KEEL_DB_SETTINGS`).
- The installer finds the right folder and network defaults on Synology,
  Unraid, TrueNAS SCALE, macOS and WSL 2, detects cloud servers, installs a
  chosen `--version`, and fails loudly when Keel doesn't start.
- Docs for macOS, Windows and NAS systems, and a Traefik example.

### Changed

- Every GitHub Action is pinned by commit, every base and third-party image by
  digest, and Dependabot keeps them and the npm packages current.
- Installs no longer follow the moving `latest` tag: the installer writes an
  exact version to `.env`. The first `./keel update` of an older install keeps
  its images as `previous` for a rollback.
- Every file is checked out with LF line endings, so the scripts work from a
  Git clone on Windows.

### Fixed

- `./keel init` no longer writes Windows' `ipconfig` help into `.env` in Git
  Bash, and a failed init no longer leaves an empty `.env` behind.
- Oversized uploads sent in small pieces get their 413 answer right away.
- Edge functions start in about a second on Docker Desktop for Windows instead
  of about 24.
- Images ship without Postgres's unused `gosu` and with Debian's latest
  security updates, so they pass the vulnerability scan.
- `./keel up` no longer stops early when `.env` has no `KEEL_STUDIO_PORT`.

## 0.1.0 - 2026-10-03

The first version, built from source or from images that followed the default
branch (no version tags were published).

### Added

- Postgres 17 with one database per project, a REST API (PostgREST), auth
  (email and password, magic links and codes, SMS, GitHub and Google sign-in,
  two-factor), storage with
  resumable uploads and image transformations, realtime (broadcast, presence,
  database changes, private channels) and edge functions (Deno), all speaking
  the Supabase APIs so apps use `@supabase/supabase-js`.
- Studio: tables, SQL editor, users, storage, functions, logs, backups,
  project settings, Studio accounts with two-factor authentication, and going
  online through a public address or a built-in Cloudflare Tunnel.
- Nightly backups with restore, project defaults, and an importer that copies
  a Supabase project into Keel.
- The documentation site, served by Keel at `/docs` and published as a
  website, with a prompt for AI coding agents.
- The `keel` command, an installer for Linux and NAS systems, and a ZimaOS
  App Store compose file.

[Unreleased]: https://github.com/niklan1110/keel/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/niklan1110/keel/releases/tag/v0.3.2
