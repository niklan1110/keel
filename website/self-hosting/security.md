# Security

Keel starts with safe defaults, but a server you run yourself is only as safe as its setup. Work through this checklist when you install Keel and whenever you open it up to more people.

| | Default | Your part |
|---|---|---|
| Secrets | Generated, weak values refused | Keep `.env` private |
| API keys | Per project, signed with the project's own secret | Never ship the service role key |
| Row level security | On for every new table | Write policies before you expose data |
| Studio | Own accounts, two-factor codes, server-side sessions, internet sign-ins only with two-factor, attempt limits | Keep it on your LAN or Tailscale; turn on two-factor |
| Ports | API (8000) on all interfaces; Studio (3000) and Postgres (5432) on this machine only, Studio on the network on a NAS or when you ask | Open only what you need |
| Postgres | TLS and a password from other machines, no superuser sign-ins from them | Keep 5432 off the internet |
| Transport | Plain HTTP | Add HTTPS for anything beyond your LAN |

## Use strong secrets

The installer and `./keel init` generate random values for `POSTGRES_PASSWORD`, `KEEL_SERVICE_PASSWORD`, `KEEL_SECRET` and `KEEL_DASHBOARD_PASSWORD` (for a ZimaOS App Store install, you generate them yourself). Each container gets only the ones it needs: the Postgres superuser password and `KEEL_SERVICE_PASSWORD` go to `keel-migrate` and `keel-studio` alone, and the gateway, REST, auth, storage, realtime and functions services each get only the password of their own database role (see [Database roles](#database-roles)). Keel refuses to start if one is missing, still has an example value such as `CHANGE_ME`, or is too short (`KEEL_SECRET` at least 32 characters, `POSTGRES_PASSWORD` 12, `KEEL_DASHBOARD_PASSWORD` 8). See [Configuration](/self-hosting/configuration#secrets).

The installer and `./keel init` create the file holding them, `.env`, readable by its owner only. On a ZimaOS App Store install, they're in the compose file. Keep it that way, keep it out of git, and keep a copy in a password manager.

## Keep the service role key secret

Each project has an **anon key**, which is public by design, and a **service role key**, which bypasses row level security and can manage users. Use the service role key only on servers you control, in edge functions (where it's available as `SUPABASE_SERVICE_ROLE_KEY`) and in scripts. Never put it in a browser, a mobile app or a public repository.

Keys are JWTs signed with the project's own signing key, and every key and user token carries the project's name. A key or token from one project is rejected by every other project, and each project has its own database.

If a key leaks, roll the keys in Studio (**Connect**) or with `./keel keys roll <project>`. Old keys keep working for a grace period (24 hours by default) so apps and signed-in users carry on, or stop at once with an emergency roll, which also signs every user out. Rolls are recorded with who did them. See [API keys and rotation](/guide/api-keys).

## Rely on row level security

Keel switches row level security on for every new table in the `public` schema, so a new table can't be read or written with the anon key or a user token until you add a policy. Studio warns when a table has it turned off. Write policies before you put data in a table that browsers can reach. See [Row level security](/database/row-level-security).

You can turn the automatic RLS off for a project (`alter database my_app set keel.auto_rls = 'off'`), but then every new table is open to the anon key until you protect it.

## Treat Studio like a root shell

Studio can run any SQL as the Postgres superuser, read every project's service role key, change sign-in settings, restore backups and stop containers. Anyone with its password controls all of your projects. That includes every Studio account, not just the owner: someone who can run SQL can also change other accounts, so only give accounts to people you'd give the database password.

- Studio has its own accounts, separate from your apps' users. The owner comes from `KEEL_DASHBOARD_USERNAME` and `KEEL_DASHBOARD_PASSWORD`; add more under **Account and security**. See [Accounts and sign-in](/studio/accounts).
- **Turn on two-factor authentication** for every account. Sign-ins from the internet require it by default (`KEEL_STUDIO_INTERNET_LOGIN=2fa`).
- Sessions last 12 hours and live on the server: signing out, a password change or removing an account ends them. Changing `KEEL_SECRET` signs everyone out.
- The session is an `HttpOnly`, `SameSite=Strict` cookie (`Secure` when you use Studio over HTTPS), so scripts on the page, including the documentation Studio serves at `/docs`, can't read it. Every API call must also carry an `X-Keel-Studio` header, and calls whose `Origin` or `Sec-Fetch-Site` names another site are refused, so other web pages can't make your browser act in Studio (cross-site request forgery).
- `KEEL_SECRET` is never used as a key itself. Studio derives a separate key from it for each use (sessions, two-factor secrets, backup download links), and only `keel-studio` gets it. Backup download links last a minute and work only while the Studio session that made them is signed in.
- Two-factor secrets are stored encrypted with a key derived from `KEEL_SECRET`, so a database backup alone doesn't give out working codes. Replacing a working two-factor setup takes turning it off first, which asks for the password.
- Requests that came through Cloudflare (or a similar edge) always count as from the internet, even if the visitor's address was removed on the way. So does a request another device forwarded with a made-up address: Keel only believes visitor addresses from proxies it trusts.
- From your network, Studio only answers to IP addresses, local names and the names in `KEEL_STUDIO_HOSTS`, so a web page can't point its own name at your server and sign in through a browser on your LAN (DNS rebinding).
- Failed sign-ins are limited to 10 per 15 minutes per address, and to 20 per hour per account from the internet.
- Keep Studio on your LAN or Tailscale. If it's only reached through a proxy on the same machine, set `KEEL_STUDIO_BIND=127.0.0.1`. If you publish it, add an access layer such as Cloudflare Access in front (not HTTP basic auth, which breaks Studio's requests), and use an HTTP proxy or tunnel, never a TCP port forwarder. See [Studio on the internet](/self-hosting/remote-access#studio-on-the-internet).

## The Docker proxy

Studio shows container status and logs and can start, stop and restart containers through `keel-docker`, a small proxy in front of the Docker socket that's part of Keel. It allows exactly four things: listing Keel's containers, reading their logs, starting, stopping and restarting them. Containers that belong to other apps on the machine are invisible, container details are cut down to labels and state (no environment variables, so no passwords or tokens), and every other Docker call is refused: it can't create containers, change images, copy files or run commands. It's on an internal Docker network that only Studio joins, and it publishes no port.

To turn container controls off entirely, tell Studio not to use Docker and stop the proxy from starting, with a `docker-compose.override.yml` next to `docker-compose.yml` (in the install folder, or the source folder):

```yaml
services:
  keel-studio:
    environment:
      DOCKER_HOST: "off"
  keel-docker:
    profiles: [disabled]
```

Then remove the running proxy and apply the change:

```bash
docker compose rm -sf keel-docker
./keel up
```

Compose reads the override file automatically, and updates leave it alone. (In a source checkout, `KEEL_DOCKER_HOST=off` in `.env` does the same as the `environment` lines.) Studio then shows each service's status from health checks only, without logs or the restart buttons; everything else works. On a ZimaOS App Store install, set `DOCKER_HOST` to `off` under `keel-studio` in the compose file and delete the `keel-docker` service instead.

## Close the ports you don't need

| Port | Service | Default bind | Recommendation |
|---|---|---|---|
| 8000 | Gateway (API) | all interfaces | Needed by your apps. Put HTTPS in front for remote access. |
| 3000 | Studio | this machine (`127.0.0.1`); your network on a NAS or with `--lan` | LAN or Tailscale only. |
| 5432 | Postgres | this machine (`127.0.0.1`) | Never on the internet. Open it to your network only if other machines need it (`--lan-db` or `KEEL_DB_BIND=0.0.0.0`). |

The installer decides where Studio listens:

- With `--lan` or `--no-lan`, as you say.
- On a **cloud server**, this machine only. The installer recognises one from the machine's firmware (`/sys/class/dmi/id`) and from the provider's metadata service at `169.254.169.254`, not from its network address: most cloud servers have a private address behind the provider's NAT and are still on the internet.
- On a **NAS** (ZimaOS, CasaOS, Synology, Unraid, TrueNAS), your network, so the NAS's dashboard can open it. In a terminal it asks first.
- Anywhere else it asks, and without an answer keeps Studio on this machine.

Reach a Studio that listens on the server only with `ssh -L 3000:127.0.0.1:3000 you@server`, or through a [Cloudflare Tunnel](/self-hosting/cloudflare-tunnel), which needs no open ports at all.

Set the binds in `.env`, or on a ZimaOS App Store install, prefix the port in the compose file, such as `"127.0.0.1:3000:3000"`. Docker-published ports bypass host firewalls like `ufw`, so binding is more reliable than a firewall rule. Don't forward 3000 or 5432 on your router. See [Configuration](/self-hosting/configuration#ports-and-network-binds).

## Postgres connections

`keel-db` writes its `pg_hba.conf` (who may connect, and how) on every start:

| Connection from | Allowed |
|---|---|
| Inside the `keel-db` container (`./keel psql`) | Yes, without a password, as in the official Postgres image. |
| Keel's own Docker networks, and **this machine** through the published port | With a password. TLS is offered but not required. |
| Anywhere else (your network, the internet) | Only over TLS and with a password (SCRAM). Keel's own service roles (`authenticator`, `keel_auth_admin` and the other `keel_*_admin` roles) are always refused, and the `postgres` superuser is refused unless `KEEL_DB_REMOTE_SUPERUSER=on`. |

"Keel's own networks" is Postgres' `samenet`: the Docker networks `keel-db` is attached to. Connections from this machine to `127.0.0.1:5432` count too, because Docker forwards them from the network's gateway address. Connections from other machines keep their own address on Linux, so they fall in the last row.

Some setups hide the client's address, and then every connection looks like it comes from Docker's network, including those from other machines:

- **Docker Desktop** on macOS and Windows, and **rootless Docker** or **Podman** with their default port forwarding.

On those, keep `KEEL_DB_BIND=127.0.0.1` (the default), or reach Postgres over Tailscale or an SSH tunnel. If you do open it (`--lan-db`), the installer and `./keel init` notice these setups and set `KEEL_DB_GATEWAY=remote`: connections from Docker's gateway then count as coming from anywhere else, so they need TLS and can't sign in as `postgres` or a service role. That includes tools on this machine (`psql` and most drivers try TLS by default); `./keel psql` and Studio are not affected. Set it yourself if you open the port by hand. If you know your setup, `KEEL_DB_LOCAL_NETWORKS` replaces `samenet` with your own list of CIDRs.

Keel's services, migrations, backups and the end-to-end tests connect through Docker's network or from this machine, so none of them need TLS. The certificate is self-signed and made on first start by a tiny `keel-db-tls` container (no network, read-only, root only to hand the key to Postgres); it lives in the `db-tls` folder and is valid for 10 years. To use your own, put `server.crt` and `server.key` in that folder and restart `keel-db`. If the certificate is missing, Postgres starts without TLS and accepts only Keel's own containers and this machine.

Studio's connection strings use the project's owner role (below), so they work from another machine with `sslmode=require` and without `KEEL_DB_REMOTE_SUPERUSER`. For an app that only needs some tables, create a role with only the rights it needs instead.

## Database roles

Each Keel service connects to Postgres as a role of its own, with its own password:

| Role | Used by | Reads of `keel.projects` |
|---|---|---|
| `authenticator` | gateway, REST (PostgREST) | name, database, JWT secret, the REST settings |
| `keel_auth_admin` | auth | name, database, JWT secret, all auth settings |
| `keel_storage_admin` | storage | name, database, JWT secret |
| `keel_realtime_admin` | realtime | name, database, JWT secret, the realtime settings |
| `keel_functions_admin` | edge functions | name, database, JWT secret, the anon and service role keys (function code gets them as `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`) |
| `keel_egress_admin` | outgoing requests from SQL (`keel-egress`) | name and database only. In project databases it can only take requests off `net.http_request_queue` and write responses. |

`keel-migrate` derives each role's password from `KEEL_SERVICE_PASSWORD` (HKDF, one label per role) and sets it on every start, so changing `KEEL_SERVICE_PASSWORD` changes them all and there's nothing new to configure. It writes each password into a folder of its own (a Docker volume, or `credentials/<role>` next to Keel's data), and each service mounts only its own, read-only. A bug that lets someone read files or run code in one service gives them that service's role, not the others, and none of these roles can sign in from outside Keel's containers. The services read `keel.projects` through the view `keel.visible_projects`, which shows each role only the columns above; only Studio and the superuser read the table itself.

### The project owner role

Each project has an owner role named after its database, such as `my_app_owner` for `my_app`. Studio's **Connect** panel and the AI agent prompt hand it out instead of the superuser. It:

- owns the `public` schema and everything in it, and can create schemas and trusted extensions (`pgcrypto`, `uuid-ossp`, `pg_trgm`, ...);
- writes tables, row level security policies, grants to `anon` and `authenticated`, `security definer` functions and triggers on `auth.users`;
- reads and writes the auth, storage and realtime tables (so a migration can insert into `storage.buckets`): policies give it every row there, like Supabase's `postgres` role, and policies on its own tables don't apply to it as their owner. It has no `BYPASSRLS`, so none of this reaches beyond its project. It also owns the `supabase_realtime` publication;
- deploys edge functions and sets function secrets for its own project (`keel fn deploy` and `keel secrets` with `KEEL_DB_URL`).

It isn't a superuser: it can't run `COPY ... PROGRAM`, read or write files on the server, create untrusted extensions or languages, connect to another project's database, or read Keel's control tables (Studio accounts, other projects' keys). Tables and functions that a superuser creates in `public` (Studio's SQL editor and table editor, `./keel psql`, restoring an older backup) are handed to the owner role automatically, so later migrations can change them. Its password is generated once and stored in Keel's control database; Studio shows it in **Connect**.

Things it can't do, which still need Studio's SQL editor: drop or replace a trigger on `auth.users` (that needs the table's owner; dropping the trigger's function with `cascade` works), write policies on `storage.objects`, `storage.buckets` or `realtime.messages`, and save or restore the project's defaults.

The owner role keeps code it writes inside its project's database, but that code (functions, triggers, views) can run in sessions of Keel's shared service roles, for example when the API calls a function. Such code could change those roles' passwords or session settings and so disturb the other projects on the server until `keel-migrate` runs again (`./keel up`). Hand owner credentials only to people and agents you'd let run code on the server's API, and use a server of its own for projects that must be isolated from each other.

## Containers run with little privilege

- Keel's own containers drop every Linux capability and set `no-new-privileges`, and run as an unprivileged user. The exceptions are `keel-docker` (root, but with no capabilities, only to open Docker's socket) and `keel-migrate` in the installer and ZimaOS files, which starts as root to hand the data folders to Keel's user, keeps only the five capabilities that takes, then switches to that user. The Postgres container runs Keel's `keel-postgres` image (the official Postgres 17 image plus pgvector and PostGIS), which drops root at start, with `no-new-privileges`.
- The gateway, REST, auth, storage, realtime and image-resize containers have a read-only filesystem; they write only to their data folders and a temporary in-memory `/tmp`.
- Every service has a Docker health check, so Docker, your NAS's dashboard or an uptime monitor shows a service that stops answering.

## The tunnel reaches only the API and Studio

Studio's **Internet access** panel runs a Cloudflare Tunnel in its own container, `keel-tunnel`. It joins only the `keel-public` Docker network, which holds the gateway and Studio, so no route set up in Cloudflare can reach Postgres, Keel's other services or your home network. It has no Keel passwords. The tunnel token is kept in the `tunnel` folder next to Keel's data, readable only by Keel's user, and Studio never shows it again after you paste it.

## Use HTTPS beyond your network

Keel serves plain HTTP. On your own network that's acceptable, but anywhere else, API keys, passwords and tokens would cross the network unencrypted. Use Tailscale, Caddy, Cloudflare Tunnel or nginx, and set `KEEL_PUBLIC_URL` to the HTTPS address. See [Internet access and HTTPS](/self-hosting/remote-access).

## Storage serves files safely

- Files are stored by internal ID, never by their names, so a file name can't escape the storage folder.
- Every file is served with `X-Content-Type-Options: nosniff`.
- Content types are checked when a file is uploaded (one plain `type/subtype`, no tricks such as `image/png, text/html`). Every file whose type isn't on a short list of passive ones (images other than SVG, audio, video, fonts, PDF, plain text, CSV, JSON, archives) is served with `Content-Security-Policy: sandbox; default-src 'none'`, so an uploaded page can't run scripts against your API's origin.
- Views you create in `public` respect row level security of the tables behind them (`security_invoker`), so a view can't be used to read around your policies.
- Storage policies on `storage.objects` decide who can upload, download and delete. See [Access control](/storage/access-control).

## Edge functions run in a sandbox

Each function runs in its own Deno process with limited permissions:

- It can read only its own code, its temp folder and the module cache, and write only its temp folder.
- It can't start subprocesses or load native libraries.
- Its environment contains only the project's secrets, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and a few Keel and system variables. Keel's own passwords aren't there.
- Memory and request time are limited (`KEEL_FUNCTIONS_MEMORY_MB`, `KEEL_FUNCTIONS_TIMEOUT`).

Function code can reach the internet, but no private or special address:

- Deno refuses connections to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (Tailscale and carrier-grade NAT), `127.0.0.0/8`, `169.254.0.0/16` (cloud metadata), `0.0.0.0/8`, multicast and the other reserved IPv4 ranges, and to `::` and `::1`. That covers Keel's containers, the Docker host and the ports it publishes (Studio, Postgres, the gateway), your router and every other device on your network.
- The ranges are checked against the address a name resolves to when the connection is made, so other names for the same machine (a container's full name, `<address>.nip.io`, the container's hostname) are refused too.
- The server's own public address is refused as well when Keel knows it: the Postgres host set in Studio or `KEEL_PUBLIC_DB_HOST`, or `KEEL_PUBLIC_URL` when it's an address rather than a name. Add other addresses with `KEEL_FUNCTIONS_DENY_NET`, for example your server's public IP when `KEEL_PUBLIC_URL` is a domain name.
- The function reaches your API through `SUPABASE_URL`. Keel sends those requests through a socket of the function's own that leads to the gateway and to the function's own project only, so `supabase-js` works as usual.
- You can open chosen devices on your network to functions with `KEEL_FUNCTIONS_ALLOW_LAN` (a local Ollama, a NAS). That opens every port of each listed address, for every project's functions; the Docker host, Keel's containers and Docker networks stay closed whatever you list. See [Allowing addresses on your network](/functions/overview#allowing-addresses-on-your-network).
- Deno can't refuse IPv6 ranges, only single IPv6 addresses. Keel's Docker networks are IPv4 only; keep it that way (`keel-functions` logs a warning if it gets an IPv6 address).

`keel-functions` sits on a Docker network of its own with only the gateway, the database and Studio, and Studio refuses connections from that network. The `keel-functions` container doesn't get `KEEL_SECRET` or the Postgres superuser password: Studio reads function logs with a token of their own (`KEEL_FUNCTIONS_TOKEN`).

Function code still runs with your project's service role key, so deploy only code you trust. Requests need a valid JWT unless you turn `verify_jwt` off for a function; do that only for webhooks that check their own signatures. See [Runtime and limits](/functions/runtime).

## Rate limits

Keel limits these per project (an "address" is the client's IP as the gateway sees it):

| What | Limit |
|---|---|
| Requests to the token endpoint (sign-in, refresh) | 120 per 5 minutes per address |
| Password sign-in attempts | 10 per 5 minutes per address and account; per account from all addresses together, 20 per hour, then each attempt waits twice as long as the last (up to 5 minutes) |
| Verifying links and codes | 30 per 5 minutes per address |
| Wrong email or SMS codes | 10 per hour per email address or phone number |
| Emails sent | 6 per hour per email address, at most one per minute per user |
| SMS sent | 6 per hour per number, 10 per hour per address, 60 per hour per project |
| Two-factor (MFA) verification | 10 per 5 minutes per user |
| Studio sign-in | 10 failed per 15 minutes per address; 20 failed per hour per account from the internet |

IPv6 visitors are counted per `/64`, since that's usually what one connection gets. Behind a reverse proxy or tunnel, Keel counts each visitor by the address the proxy passes on, but only for proxies it trusts (its own tunnel, a proxy on the server when the port is bound to `127.0.0.1`, and `KEEL_TRUSTED_PROXIES`); anything else forwarded counts under the address of whoever connected. See [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies). Test phone numbers don't count toward the SMS limits.

Against slow or flooding clients, the gateway and storage close a request body that stalls for two minutes, each client address can hold at most 500 connections, and realtime accepts at most 200 connections per address and project. See [Limits](/self-hosting/configuration#limits).

## Logs stay small and quiet

- Docker keeps at most 30 MB of logs per container (three files of 10 MB), so a flood of requests can't fill the disk.
- Postgres logs slow statements without the values passed to them, so passwords and personal data in queries don't end up in its log.
- Database errors a client causes are logged with their code and the table or constraint, not the values that were sent (unless `KEEL_LOG_PII=on`).
- Logs do hold client IP addresses: failed sign-ins, rate limits and proxy warnings name the address, as security records. They go when Docker rotates the log files (see above); keep that in mind if you copy logs elsewhere or have to state how long you keep personal data.
- The public API answers the same way for a project that doesn't exist as for a wrong API key, doesn't report Keel's version and doesn't name internal services in its errors.

## Imports run with limited rights

The [Supabase importer](/self-hosting/migrate-from-supabase) treats the source project as untrusted. Its schema is restored by a dedicated role, `keel_import_<database>`, that isn't a superuser and can only log in while an import runs. That role owns the imported tables and functions, so `SECURITY DEFINER` functions and other code from the source never run as the Postgres superuser. Triggers and policies on Keel's own tables are recreated one statement at a time as those tables' owners.

## Keep Keel updated

Updates include security fixes. Update regularly (see [Updating](/self-hosting/updating)), Postgres' bug-fix releases arrive with Keel's releases, in the `keel-postgres` image.


## Next steps

<div class="cards">
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Put Keel online the safe way.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>An encrypted copy of everything, off the machine.</span></a>
  <a class="card" href="../studio/accounts"><strong>Accounts and sign-in</strong><span>Two-factor authentication for every Studio account.</span></a>
</div>
