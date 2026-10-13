# Configuration

Keel is configured with environment variables, set once for the whole server. Settings that differ between apps, such as sign-in options and email, are per project and live in Studio instead.

```bash
# .env in the install folder
KEEL_PUBLIC_URL=http://192.168.1.20:8000
KEEL_BACKUP_SCHEDULE=02:30
TZ=Europe/Berlin
```

## Where settings live

| Install | File | Apply a change |
|---|---|---|
| [Installer](/self-hosting/docker), on any Linux machine or [ZimaOS](/self-hosting/zimaos) | `.env` in the install folder: `/opt/keel`, `~/keel` or `/DATA/AppData/keel` | `./keel up` in that folder (with `sudo` if you installed with it) |
| [Compose file set up by hand](/self-hosting/docker#install-by-hand) | `.env` next to `docker-compose.yml` | `docker compose up -d` in that folder |
| [ZimaOS App Store](/self-hosting/zimaos#option-b-app-store-custom-app) | The `x-keel-env` block at the top of the compose file, written into the file itself | `docker compose up -d` in the compose file's folder |
| [Built from source](/self-hosting/docker#build-from-source-if-you-have-the-source-code) | `.env` in the source folder | `./keel up` |

Keel's services read their settings when they start. `up -d` recreates every container whose settings changed; `docker compose restart` does **not** pick up a changed `.env`.

## KEEL_PUBLIC_URL

`KEEL_PUBLIC_URL` is the address of the gateway as your apps and users see it: scheme, host and port, without a project name or trailing slash. A project's API URL is this address plus the project name:

```text
KEEL_PUBLIC_URL     http://192.168.1.20:8000
API URL (my-app)    http://192.168.1.20:8000/my-app
```

Your apps don't read it (they use whatever URL you pass to `createClient`). Keel uses it wherever it has to tell someone how to reach it:

| Service | Uses it for |
|---|---|
| `keel-auth` | Links in sign-up, magic link, invite, password reset and email change emails, and the OAuth callback URL (`<KEEL_PUBLIC_URL>/<project>/auth/v1/callback`) it sends to sign-in providers. |
| `keel-studio` | The **Connect** panel (API URL, REST endpoint, and the Postgres host unless `KEEL_PUBLIC_DB_HOST` is set), the callback URL under **Users > Sign-in settings**, function URLs and public file URLs. |
| `keel-functions` | `KEEL_PUBLIC_URL` inside your edge functions, set to `<KEEL_PUBLIC_URL>/<project>`. (`SUPABASE_URL` points at Keel's internal address instead.) |
| `keel-storage` | Resumable upload URLs, when the request doesn't say which address it arrived on. |
| `keel-rest` | The server URL in the REST API's OpenAPI description. |

Storage's signed URLs are relative: the client library prefixes them with the URL it was created with, so they keep working whatever `KEEL_PUBLIC_URL` says.

**Pick the address the devices that use Keel can reach.** `http://localhost:8000` works only on the server itself. For phones and laptops on your network use the server's LAN address, such as `http://192.168.1.20:8000`. Behind HTTPS, use the HTTPS address, such as `https://api.example.com` or `https://nas.tail1234.ts.net:8461`. See [Internet access and HTTPS](/self-hosting/remote-access).

**Setting it:**

- **In Studio (any install):** click **Connect**, then **Internet access**, and change **Public address**. Every service picks it up within a second, without a restart, and it wins over the value in your settings file. **Use the server setting** goes back to that value. The host shown in Postgres connection strings stays your server's own (a tunnel or proxy only carries web traffic); the same panel can change it.
- **Installer:** it sets it to `http://<this machine's IP>:8000`, or from `KEEL_HOST` or `KEEL_PUBLIC_URL` when you pass them (see [Options](/self-hosting/docker#options)). Later, edit `KEEL_PUBLIC_URL` in `.env` and run `./keel up`.
- **Compose file set up by hand:** you fill it in in `.env`; Keel doesn't start without it.
- **ZimaOS App Store:** edit `KEEL_PUBLIC_URL` in the compose file's `x-keel-env` block and run `docker compose up -d`.
- **Built from source:** `./keel init --url ...` sets it. Later, edit `.env` and run `./keel up`.

Every Keel service reads the settings-file value at startup, so recreate the whole stack after changing it there (the commands above do); a value set in Studio applies right away. If you use sign-in with GitHub, Google or another provider, update the callback URL there too.

## Secrets

The installer and `./keel init` generate these for you. To make a set by hand, for a ZimaOS App Store install or a `.env` you write yourself:

```bash
docker run --rm @@IMAGES@@/keel:latest generate-env
```

Keel refuses to start with a weak or example secret:

| Variable | Minimum length | Checked by |
|---|---|---|
| `KEEL_SECRET` | 32 characters | `keel-studio` |
| `KEEL_FUNCTIONS_TOKEN` (optional) | 32 characters | `keel-functions` |
| `POSTGRES_PASSWORD` | 12 characters | `keel-migrate`, `keel-studio` |
| `KEEL_SERVICE_PASSWORD` | 12 characters | `keel-migrate`, `keel-studio` (the other services get a password derived from it) |
| `KEEL_DASHBOARD_PASSWORD` | 8 characters | `keel-studio` |

Values that start with `change me`, `change-me`, `change_me` or `changeme` (in any case, so `CHANGE_ME_POSTGRES_PASSWORD` too), placeholders in angle brackets such as `<password>`, and the words `password`, `secret`, `changeme` and `example` are rejected. The container log then says, for example, "POSTGRES_PASSWORD still has its example value" or "KEEL_SECRET must be at least 32 characters long."

### Change a secret

- **`KEEL_DASHBOARD_PASSWORD`:** edit it and recreate `keel-studio`. Studio sessions that are already signed in stay valid until they expire (12 hours); change `KEEL_SECRET` too to sign everyone out.
- **`KEEL_SECRET`:** edit it and recreate `keel-studio`. Everyone is signed out of Studio, and accounts with two-factor authentication can't sign in until you clear it with `./keel studio-user reset-2fa <name>` (the two-factor secrets are encrypted with a key derived from it).
- **`KEEL_FUNCTIONS_TOKEN`:** edit it and recreate `keel-studio` and `keel-functions`.
- **`POSTGRES_PASSWORD`:** Postgres keeps the password it was created with, so change it in the database first, then in your settings:

  ```bash
  ./keel psql
  ```

  ```sql
  alter role postgres password 'NEW_LONG_RANDOM_PASSWORD';
  ```

  Then set `POSTGRES_PASSWORD=NEW_LONG_RANDOM_PASSWORD` in `.env` and run `./keel up`. (On a ZimaOS App Store install, open `psql` with `docker compose exec keel-db psql -U postgres` in the compose file's folder, and change the password in its `x-secrets` block.)
- **`KEEL_SERVICE_PASSWORD`:** edit it and recreate the stack (`./keel up`). Every time it starts, before the other services connect, `keel-migrate` derives a password for each of Keel's internal service roles from it, sets them, and writes each into a folder that only the service using that role mounts. Installs from before this setting existed use `POSTGRES_PASSWORD` for those roles until you add it; re-running the installer adds it for you.

## Per-project settings

Settings that can differ between your apps are set per project in Studio and apply within a second, without a restart:

| What | Where in Studio |
|---|---|
| Site URL, allowed redirect URLs, sign-ups, email confirmation, anonymous sign-ins, minimum password length, session token lifetime | **Users > Sign-in settings** |
| Mail server (overrides the `SMTP_*` variables for this project) | **Users > Sign-in settings > Mail server** |
| Phone sign-in and SMS provider, two-factor authentication, sign-in providers (GitHub, Google, Discord, GitLab, Microsoft, OpenID Connect) | **Users > Sign-in settings** |
| Private channels only (realtime) | **Project settings > Realtime** |

The `SMTP_*` variables are the default mail server for every project that doesn't set its own. Row level security on new tables is per project too: `alter database my_app set keel.auto_rls = 'off'` turns it off (see [Row level security](/database/row-level-security)).

## Ports and network binds

Keel publishes three ports. The API (8000) listens on every network interface. Studio (3000) and Postgres (5432) listen on this machine only (`127.0.0.1`) unless you open them: `./keel init --lan` or the installer's `--lan` for Studio, `--lan-db` for Postgres. On a NAS the installer opens Studio to your network by default. With the installer, a compose file set up by hand or a source checkout, change them in `.env`:

```bash
KEEL_GATEWAY_PORT=8080          # API on port 8080 instead of 8000
KEEL_STUDIO_BIND=0.0.0.0        # Studio reachable from your network
KEEL_DB_BIND=127.0.0.1          # Postgres reachable only from this machine (the default)
```

Then run `./keel up`. If you change `KEEL_GATEWAY_PORT`, change the port in `KEEL_PUBLIC_URL` to match. `KEEL_DB_PORT` also sets the port shown in Studio's Postgres connection string.

`0.0.0.0` means every interface: your network, and the internet too on a server with a public address. Docker's published ports bypass host firewalls such as `ufw` and `firewalld`, so the bind is what actually keeps a port private.

On a ZimaOS App Store install, edit the left-hand side of each `ports:` entry in the compose file instead, for example `"0.0.0.0:8080:8000"`, `"127.0.0.1:3000:3000"` to keep Studio on the NAS, or `"0.0.0.0:5432:5432"` to open Postgres. If you change the Postgres port, set `KEEL_PUBLIC_DB_PORT` in `x-keel-env` to match.

### Postgres from other machines

When Postgres is open to your network (`KEEL_DB_BIND=0.0.0.0`), connections from other machines must use TLS and a password, and the `postgres` superuser can't sign in from them. Keel's own containers and this machine connect as before. See [Security](/self-hosting/security#postgres-connections) for the details.

```bash
KEEL_DB_BIND=0.0.0.0
KEEL_DB_REMOTE_SUPERUSER=on     # also let postgres sign in from other machines (with TLS)
```

Clients then need `sslmode=require` (most do this by themselves when the server offers TLS; `psql` and libpq default to `prefer`). The certificate is self-signed, made on the first start, and kept in the `db-tls` folder of your install (`keel_keel-db-tls` volume in a source checkout); put your own `server.crt` and `server.key` there to use another one, and use `sslmode=verify-full` with it.

## All variables

Defaults are those of the installer's compose file (`docker-compose.yml`), which you can also set up by hand. The ZimaOS App Store file and a source checkout use the same defaults unless noted. In the App Store file, add a setting to the `x-keel-env` block; it's passed to every service.

### Required

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | generated | Postgres superuser password. Only `keel-migrate` and `keel-studio` get it. Set it once (see [Change a secret](#change-a-secret)). |
| `KEEL_SERVICE_PASSWORD` | generated | Base secret of Keel's internal service roles (`authenticator`, `keel_*_admin`). Only `keel-migrate` and `keel-studio` get it: `keel-migrate` derives one password per role from it, and the gateway, REST, auth, storage, realtime and functions services each get only their own role's password (see [Database roles](/self-hosting/security#database-roles)). Falls back to `POSTGRES_PASSWORD` when unset. |
| `KEEL_SECRET` | generated | Studio's master secret: keys for Studio sessions, two-factor secrets and backup download links are derived from it. Only `keel-studio` gets it. |
| `KEEL_FUNCTIONS_TOKEN` | generated | Token Studio uses to read function logs from `keel-functions`. Without it, one is derived from `keel_functions_admin`'s password (and so from `KEEL_SERVICE_PASSWORD`). |
| `KEEL_DASHBOARD_USERNAME` | `admin` | Studio username. |
| `KEEL_DASHBOARD_PASSWORD` | generated | Studio password. |

### Network

| Variable | Default | Description |
|---|---|---|
| `KEEL_PUBLIC_URL` | Set by the installer | How apps reach the gateway. See [above](#keel-public-url). Required by the installer's compose file; a source checkout falls back to `http://localhost:8000`. |
| `KEEL_EXPOSURE` | empty | Whether the internet can reach this server: `internet`, `lan`, or empty to judge from `KEEL_PUBLIC_URL`. On `internet`, new projects start with email confirmation on and, without a mail server, sign-ups off (see [Passwords](/auth/passwords#confirming-email-addresses)). The installer and `./keel init` set `internet` on a cloud server, whose own address looks private behind the provider's NAT. |
| `KEEL_HOST_LABEL` | host name from `KEEL_PUBLIC_URL` | Name shown in Studio's header. `./keel init` sets the machine's hostname; the ZimaOS App Store file uses `ZimaOS`. |
| `KEEL_GATEWAY_PORT` | `8000` | Host port for the API gateway. |
| `KEEL_STUDIO_PORT` | `3000` | Host port for Studio. |
| `KEEL_DB_PORT` | `5432` | Host port for Postgres, also shown in Studio's connection string. |
| `KEEL_PUBLIC_DB_HOST` | host name from `KEEL_PUBLIC_URL` | Host shown in Studio's Postgres connection string. Set it when the API is behind a domain that doesn't serve Postgres, such as a reverse proxy. Set it in `.env`, or in the App Store file's `x-keel-env` block. |
| `KEEL_GATEWAY_BIND` | `0.0.0.0` | Interface for the gateway port. `127.0.0.1` keeps it local. Not in the App Store file (edit `ports:` there). |
| `KEEL_STUDIO_BIND` | `127.0.0.1` | Interface for the Studio port: `127.0.0.1` for this machine only, `0.0.0.0` for your network. The installer sets it (`0.0.0.0` on a NAS or with `--lan`). Not in the App Store file, which opens Studio to the network. |
| `KEEL_DB_BIND` | `127.0.0.1` | Interface for the Postgres port. `0.0.0.0` opens it to your network (with TLS required, see [above](#postgres-from-other-machines)). Not in the App Store file. |
| `KEEL_DB_REMOTE_SUPERUSER` | `off` | `on` lets the `postgres` superuser sign in from other machines (over TLS). Keel's containers and this machine are not affected. |
| `KEEL_DB_GATEWAY` | `local` | `remote` treats connections from the Docker network's gateway as coming from other machines (TLS required, no `postgres` or service role sign-ins). For Docker Desktop, rootless Docker and Podman, where every outside client arrives from there; the installer and `./keel init --lan-db` set it. See [Security](/self-hosting/security). |
| `KEEL_DB_LOCAL_NETWORKS` | `samenet` | Which addresses Postgres treats as Keel's own (password, TLS optional, superuser allowed). `samenet` means the Docker networks `keel-db` is on, which includes this machine connecting through the published port. Replace it with a space- or comma-separated list of CIDRs if your Docker setup hides the client's address (see [Security](/self-hosting/security#postgres-connections)). |
| `KEEL_LOCAL_NETWORKS` | `private` | What counts as your network: `private` (LAN ranges, Tailscale's `100.64.0.0/10`, the server itself), `none`, or a comma-separated list of addresses and CIDR ranges such as `192.168.1.0/24, 100.64.0.0/10`. Everything else is the internet. Used for rate limits and Studio's internet sign-in rule. |
| `KEEL_TRUSTED_PROXIES` | empty | Proxies whose `X-Forwarded-For` (the visitor's address) Keel believes, besides its own gateway and Cloudflare Tunnel: `host` for a reverse proxy on the server itself (Caddy, nginx, `tailscale serve`), container names, addresses and CIDR ranges, comma-separated. A proxy on the server is trusted automatically when the port it connects to is bound to `127.0.0.1`. See [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies). |
| `KEEL_STUDIO_HOSTS` | empty | Host names Studio answers to besides IP addresses, `localhost`, names that only exist on your network (`nas`, `nas.local`, `*.lan`, `*.home.arpa`, `*.ts.net`) and the public addresses. Comma-separated; `*.example.com` allows subdomains, `*` any name. Other names get `421` from your network and through a proxy on this machine, which protects against DNS rebinding. If you serve Studio through Caddy or nginx under a domain, add that domain here (Cloudflare Tunnel needs nothing). |
| `KEEL_GATEWAY_DOCS` | `on` | `off` stops the API port from serving this documentation at `/docs` (Studio still serves it). Useful when the API is on the internet and you'd rather point people at the public Keel website. Not in the App Store file (add it to `x-keel-env`). |
| `KEEL_STUDIO_INTERNET_LOGIN` | `2fa` | Studio sign-ins from the internet: `2fa` (only accounts with two-factor authentication), `on`, or `off`. See [Accounts and sign-in](/studio/accounts#sign-ins-from-the-internet). |

### Limits

Protection against clients that send slowly or open too many connections. The defaults are generous; lower them on a small machine, raise them if many users share one address (a school or office network).

| Variable | Default | Description |
|---|---|---|
| `KEEL_BODY_IDLE_TIMEOUT` | `120` | Seconds a request body may send nothing before the gateway and storage close the request. Large uploads on slow links are fine as long as data keeps arriving. `0` turns it off. |
| `KEEL_MAX_CONNECTIONS_PER_IP` | `500` | Open connections per client address at the gateway and storage. Keel's trusted proxies don't count. `0` turns it off. |
| `KEEL_REALTIME_MAX_PER_IP` | `200` | Realtime (WebSocket) connections per client address in one project. Above it, new connections get `429`. |
| `KEEL_REALTIME_MAX_PER_PROJECT` | `10000` | Anonymous realtime connections per project (sockets that haven't joined a channel with a user's token). Past it, new ones are closed after 10 seconds unless they sign in; signed-in users and the service role aren't counted, so someone holding sockets with the public anon key can't keep them out. |

### Projects

| Variable | Default | Description |
|---|---|---|
| `KEEL_DEFAULT_PROJECT` | `my-app` | Project created on the first start (when there are no projects), and the default for `--project` in [CLI](/self-hosting/cli) commands. |

### Email

| Variable | Default | Description |
|---|---|---|
| `SMTP_HOST` | empty | Mail server for auth emails. Empty means no email: new accounts are confirmed automatically, and other emails are not sent (their links are never logged). |
| `SMTP_PORT` | `587` | Mail server port. |
| `SMTP_USER` | empty | Username. |
| `SMTP_PASS` | empty | Password. |
| `SMTP_FROM` | `Keel <no-reply@keel.local>` | Sender, for example `"My App <no-reply@example.com>"`. |
| `SMTP_SECURE` | `false` | `true` uses TLS from the start (port 465, which also turns it on). Otherwise STARTTLS is used when the server offers it. |

See [Email setup](/auth/email).

### Storage

| Variable | Default | Description |
|---|---|---|
| `KEEL_STORAGE_MAX_FILE_SIZE` | `524288000` (500 MB) | Largest upload in bytes. Buckets can set a lower limit. A source checkout defaults to `52428800` (50 MB). |
| `IMGPROXY_KEY`, `IMGPROXY_SALT` | unset | Hex key and salt that sign image transformation requests between `keel-storage` and `keel-imgproxy`. The installer and `./keel init` generate them, and re-running the installer adds them to an older `.env`. The App Store file leaves them out (the image resizer only reads files from storage and isn't published outside Docker either way). |

### Edge functions

| Variable | Default | Description |
|---|---|---|
| `KEEL_FUNCTIONS_MEMORY_MB` | `256` | Memory (V8 heap) per function process. |
| `KEEL_FUNCTIONS_TIMEOUT` | `150` | Longest time a request may take, in seconds. Longer requests get a 504. |
| `KEEL_FUNCTIONS_IDLE` | `300` | Stop a function's process after this many seconds without requests. |
| `KEEL_FUNCTIONS_MAX_WORKERS` | `20` | Function processes that may run at once. |
| `KEEL_FUNCTIONS_BOOT_TIMEOUT` | `90` | Seconds a function may take to start, including downloading its imports the first time. |
| `KEEL_FUNCTIONS_DENY_NET` | empty | More addresses function code may not connect to, comma separated (IPv4 addresses or ranges such as `203.0.113.0/24`, IPv6 addresses in brackets). Private ranges are always refused; use this for your server's public IP when `KEEL_PUBLIC_URL` is a domain name. See [Edge functions run in a sandbox](/self-hosting/security#edge-functions-run-in-a-sandbox). |
| `KEEL_FUNCTIONS_ALLOW_LAN` | empty | LAN addresses function code may connect to, comma separated: IPv4 addresses with an optional port (`192.168.1.50:11434`) or ranges up to `/24` (ranges only with `KEEL_HOST_ADDRESSES` set). Every port of a listed address is reachable, whatever port you write. This server, Keel's containers and Docker networks are never opened. See [Allowing addresses on your network](/functions/overview#allowing-addresses-on-your-network). |
| `KEEL_HOST_ADDRESSES` | set by the installer | This server's own LAN addresses, comma separated. Function code can't reach them, even inside a range in `KEEL_FUNCTIONS_ALLOW_LAN`. The installer and `./keel init` fill it in; set it yourself (and keep it current if the address changes) to allow ranges. |

The installer's compose file and a source checkout pass all of these from `.env`. The ZimaOS App Store file sets none of them, so add the ones you want to its `x-keel-env` block. See [Runtime and limits](/functions/runtime).

### Scheduled jobs and outgoing requests

`KEEL_CRON_*` are read by `keel-studio`, which runs [scheduled jobs](/database/cron); `KEEL_NET_*` by `keel-egress`, which sends [HTTP requests from SQL](/database/webhooks). `keel-egress` also gets `KEEL_FUNCTIONS_ALLOW_LAN`, `KEEL_FUNCTIONS_DENY_NET` and `KEEL_HOST_ADDRESSES` above: its requests follow the same rules as edge functions. The ZimaOS App Store file passes none of these; add them to its `keel-studio` or `keel-egress` service.

| Variable | Default | Description |
|---|---|---|
| `KEEL_CRON_TIMEOUT` | `300` | Seconds a cron run may take before it is stopped. |
| `KEEL_CRON_MAX_RUNNING` | `4` | Cron jobs of one project that may run at once. |
| `KEEL_CRON_HISTORY_DAYS` | `7` | Days `cron.job_run_details` (and `supabase_functions.hooks`) keep a row. |
| `KEEL_NET_MAX_TIMEOUT_MS` | `60000` | Longest an HTTP request may take, whatever `timeout_milliseconds` asks for. |
| `KEEL_NET_MAX_RESPONSE_BYTES` | `1048576` | Largest response body kept; a larger response fails. |
| `KEEL_NET_CONCURRENCY` | `8` | HTTP requests of one project in flight at once. |
| `KEEL_NET_TTL_HOURS` | `6` | Hours `net._http_response` keeps a response. |

### Backups

| Variable | Default | Description |
|---|---|---|
| `KEEL_BACKUP_SCHEDULE` | `03:00` | Daily time (`HH:MM`, in the container's time zone) for a `pg_dump` of every project and a full backup, or `off`. A time set in Studio wins. |
| `KEEL_BACKUP_RETENTION` | `7` | Nightly backups kept per project. Manual backups are kept until you delete them. |
| `KEEL_BACKUP_PASSPHRASE` | empty | Turns on [full backups](/self-hosting/backups#full-backups) and encrypts them. 12 characters or more. Keep a copy somewhere other than the server. |
| `KEEL_BACKUP_PASSPHRASE_FILE` | empty | A file holding the passphrase instead (such as a Docker secret). |
| `KEEL_BACKUP_KEEP_LOCAL` | `2` | Full backups kept on the server (the newest ones). |
| `KEEL_BACKUP_S3_ENDPOINT` | `https://s3.<region>.amazonaws.com` | Address of the S3-compatible service for off-site copies. |
| `KEEL_BACKUP_S3_REGION` | `us-east-1` | Its region (`auto` for Cloudflare R2). |
| `KEEL_BACKUP_S3_BUCKET` | empty | The bucket. Setting it turns the target on, and it wins over a target set in Studio. |
| `KEEL_BACKUP_S3_PREFIX` | empty | Folder in the bucket, such as `keel`. |
| `KEEL_BACKUP_S3_ACCESS_KEY_ID`, `KEEL_BACKUP_S3_SECRET_ACCESS_KEY` | empty | The access key. |
| `KEEL_BACKUP_S3_PATH_STYLE` | `on` | Bucket name in the path (`on`) or in the host name (`off`). |
| `TZ` | `UTC` | Time zone of the containers, used by the backup schedule and timestamps. |

### Images, Docker and logs

| Variable | Default | Description |
|---|---|---|
| `KEEL_VERSION` | `latest` | Image tag for Keel's images (`keel`, `keel-functions`, `keel-postgres`) in the installer's compose file, such as `0.2.0`. The installer and `./keel update` write the version to `.env` (`--version` picks it). See [Pin a version](/self-hosting/updating#pin-a-version). |
| `KEEL_PREVIOUS_VERSION` | none | The version before the last update, written by `./keel update`; `./keel rollback` goes back to it. |
| `KEEL_DB_VERSION` | `KEEL_VERSION` | Image tag for `keel-postgres` (`keel-db`) when it differs from `KEEL_VERSION`. Only `./keel rollback` sets it, when going back to a version from before `keel-postgres`: the database keeps the image it runs. The next `./keel update` clears it. |
| `KEEL_UPDATE_CHECK` | `on` | Studio asks GitHub once a day, while you use it, whether a newer release exists, and shows it next to the version in the project settings. The request carries no cookie, version, host name or ID; GitHub only sees this server's address. `off` turns it off. |
| `KEEL_IMAGE` | `keel:local` | Source checkout: image for the core services. Set to `@@IMAGES@@/keel:<tag>` to use published images instead of building. |
| `KEEL_FUNCTIONS_IMAGE` | `keel-functions:local` | Source checkout: image for `keel-functions`, such as `@@IMAGES@@/keel-functions:<tag>`. |
| `KEEL_DB_IMAGE` | `keel-postgres:local` | Source checkout: image for `keel-db` (Postgres with pgvector and PostGIS), such as `@@IMAGES@@/keel-postgres:<tag>`. |
| `KEEL_DOCKER_HOST` | `tcp://keel-docker:2375` | How Studio reaches Docker. Set to `off` (or empty) to turn off Studio's container status, logs and controls. For other installs, see [The Docker proxy](/self-hosting/security#the-docker-proxy). |
| `KEEL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `KEEL_ALLOW_DOWNGRADE` | `off` | For development only, set on `keel-migrate` in a `docker-compose.override.yml`: lets it start an image older than the database. Never on a real install; restore a backup instead (see [Rolling back](/self-hosting/updating#rolling-back)). |
| `KEEL_LOG_PII` | `off` | `on` writes full email addresses, phone numbers and request paths to the logs, for debugging. Off, they're masked. Sign-in links and codes are never logged. See [Personal data in logs](/studio/logs#personal-data-in-logs). |
| `KEEL_SLOW_QUERY_MS` | `200` | Postgres logs statements slower than this many milliseconds, without the values passed to them. The App Store compose file has it fixed at 200. |
| `KEEL_DB_SETTINGS` | none | Extra Postgres settings, separated by spaces, such as `shared_buffers=64MB work_mem=2MB`. Each becomes a `-c` option of the server. See [Small devices](/self-hosting/platforms#raspberry-pi-and-small-nas). |
| `KEEL_PUBLIC_NETWORK` | `keel-public` | Name of the Docker network that holds only the gateway, Studio and the tunnel (what a [Cloudflare Tunnel](/self-hosting/cloudflare-tunnel) or [Traefik](/self-hosting/remote-access#traefik) joins). A second Keel on the same machine needs its own; the Windows installer's `-ProjectName` sets `<name>-public`. |
| `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME` | | Read by Docker Compose itself: the compose files to combine (separated by `:`, or `;` on Windows) and the project name. The Windows installer sets `COMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml`, which keeps the database in a Docker volume (see [Windows](/self-hosting/windows#where-your-data-lives)). |

### Advanced

Keel's services also read these. The compose files set some of them for you and don't pass the rest, so you rarely need them. To set one, add it to the service's `environment:` in a `docker-compose.override.yml` next to `docker-compose.yml`, which Compose reads automatically and updates leave alone (or, on a ZimaOS App Store install, to the `x-keel-env` block):

```yaml
# docker-compose.override.yml
services:
  keel-rest:
    environment:
      KEEL_POSTGREST_MAX_ROWS: "5000"
```

| Variable | Default | Description |
|---|---|---|
| `KEEL_DB_URL` | none | A `postgresql://user:password@host:port/db` URL that replaces `KEEL_DB_HOST`, `KEEL_DB_PORT`, `POSTGRES_USER` and `POSTGRES_PASSWORD`. Meant for running the image's CLI from another computer (see [keel CLI](/self-hosting/cli#from-another-computer)); the services don't need it. |
| `KEEL_PUBLIC_DB_PORT` | `5432` | Port shown in that string. The compose files set it from `KEEL_DB_PORT`. |
| `KEEL_DB_HOST` | `keel-db` | Postgres host the services connect to. |
| `KEEL_DB_PORT` | `5432` | Inside the containers: Postgres port the services connect to. (In `.env` the same name sets the published port, which the compose file passes on as `KEEL_PUBLIC_DB_PORT`.) |
| `POSTGRES_USER` | `postgres` | Superuser name. |
| `KEEL_CONTROL_DB` | `keel` | Keel's control database. |
| `KEEL_POSTGREST_MAX_ROWS` | `1000` | Most rows one REST request returns. |
| `KEEL_POSTGREST_POOL` | `10` | Database connections per project's PostgREST. |
| `KEEL_POSTGREST_BASE_PORT` | `3100` | First internal port for the PostgREST processes. |
| `KEEL_POSTGREST_LOG_LEVEL` | `info` | PostgREST's log level. |
| `KEEL_STORAGE_ROOT` | `/var/lib/keel/storage` | Where `keel-storage` keeps files. |
| `KEEL_FUNCTIONS_ROOT` | `/var/lib/keel/functions` | Function working copies and Deno's cache. |
| `KEEL_BACKUP_DIR` | `/var/lib/keel/backups` | Where Studio writes backups. |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Docker API address for Studio. The compose files set it to the `keel-docker` proxy. |
| `KEEL_COMPOSE_PROJECT` | detected | Compose project whose containers Studio shows. Studio detects it from its own container. |
| `KEEL_REST_URL`, `KEEL_AUTH_URL`, `KEEL_STORAGE_URL`, `KEEL_REALTIME_URL`, `KEEL_IMGPROXY_URL`, `KEEL_GATEWAY_URL`, `KEEL_FUNCTIONS_URL` | `http://keel-<service>:<port>` | Internal service addresses. |
| `KEEL_REST_PORT`, `KEEL_AUTH_PORT`, `KEEL_STORAGE_PORT`, `KEEL_REALTIME_PORT`, `KEEL_FUNCTIONS_PORT` | `3000`, `9999`, `5000`, `4000`, `9000` | Internal listening ports. |
| `KEEL_POSTGREST_BIN`, `KEEL_DENO_BIN`, `KEEL_FUNCTIONS_RUNTIME`, `KEEL_STUDIO_STATIC`, `KEEL_DOCS_STATIC` | set in the images | Paths to binaries and built files. |
