# Linux (Docker Compose)

Keel runs as a Docker Compose stack. This page installs it on a Linux server or PC with one command, explains every installer option, shows how to set the compose file up by hand or build from source, and lists the services and where your data lives. The same installer works on a Mac with Docker Desktop, OrbStack or Colima, in WSL 2, and on NAS systems such as ZimaOS, CasaOS, Synology, Unraid and TrueNAS SCALE. On Windows, use the [Windows installer](/self-hosting/windows), a PowerShell script that works the same way.

```bash
curl -fsSL @@SITE@@/install.sh | sudo bash
```

Check the [requirements](/self-hosting/requirements) first. For what's different on each system (where to open a terminal, the data folder, a NAS's own app screen), see [Windows](/self-hosting/windows), [macOS](/self-hosting/macos), [ZimaOS](/self-hosting/zimaos), [Unraid](/self-hosting/unraid), [TrueNAS SCALE](/self-hosting/truenas) and [Synology](/self-hosting/synology).

## Install with the installer

The installer needs Docker with the Compose plugin, and `curl`. Run it as root (with `sudo`) or as a user who can run `docker`:

```bash
curl -fsSL @@SITE@@/install.sh | sudo bash
```

It:

1. picks an install folder: `/DATA/AppData/keel` on ZimaOS and CasaOS, `/volume1/docker/keel` on Synology, `/mnt/user/appdata/keel` on Unraid, a pool under `/mnt` on TrueNAS SCALE, `~/keel` on a Mac, otherwise `/opt/keel` when run as root and `~/keel` when not;
2. decides who can open Studio: your network on a NAS, this machine only on a cloud server, and elsewhere it asks (see [Security](/self-hosting/security#close-the-ports-you-don-t-need)). Postgres stays on this machine;
3. downloads Keel's `docker-compose.yml` and the [`keel` command](/self-hosting/cli) into that folder, and keeps each only if it matches its checksum in the published `SHA256SUMS`;
4. downloads the Keel images and writes your settings to `.env` in the folder, readable only by its owner: random values for `POSTGRES_PASSWORD`, `KEEL_SECRET` and `KEEL_DASHBOARD_PASSWORD`, `KEEL_PUBLIC_URL` set to `http://<this machine's IP>:8000`, the image version and the network binds;
5. creates the `db`, `storage`, `backups`, `functions` and `tunnel` folders for your data;
6. starts Keel, waits until Studio answers and prints your login. If Studio never answers, it shows the containers' state and last log lines and stops with an error instead.

```text
Keel is running.

  Studio (dashboard):  http://192.168.1.20:3000
  Sign in:             admin / <generated password>
  API for your apps:   http://192.168.1.20:8000/my-app
  Settings:            /opt/keel/.env   (passwords; keep a copy somewhere safe)
  Data:                /opt/keel/{db,db-tls,storage,backups,functions,tunnel}

Next: open Studio, change your password and turn on two-factor authentication
under "Account and security". Manage Keel with /opt/keel/keel (./keel help).
```

Keep a copy of `.env` somewhere safe, such as a password manager. It holds the passwords you need to restore a backup on another machine.

That example was installed with `--lan`. Without it, Studio listens on the machine itself, and the installer tells you how to reach it (`http://localhost:3000` on that machine, or through an SSH tunnel on a server).

### Options

Pass these as flags after `bash -s --`, or set the variable before `bash`:

| Flag | Variable | Default | What it does |
|---|---|---|---|
| `--dir DIR` | `KEEL_DIR` | depends on the system (see above) | Where to install. |
| `--version V` | `KEEL_VERSION` | the newest release | Image version to install, such as `0.2.0`. Written to `.env`, so updates stay on it until you change it (see [Pin a version](/self-hosting/updating#pin-a-version)). |
| `--host HOST` | `KEEL_HOST` | This machine's IP address | The address part of `KEEL_PUBLIC_URL`, such as a hostname or Tailscale name. The API URL becomes `http://<KEEL_HOST>:8000`. |
| `--url URL` | `KEEL_PUBLIC_URL` | `http://<KEEL_HOST>:8000` | The full address apps use to reach the API, such as `https://api.example.com` behind a reverse proxy. |
| `--lan` / `--no-lan` | `KEEL_LAN=yes` / `no` | yes on a NAS, no on a cloud server, asked elsewhere | Open Studio to your network, or keep it on this machine. |
| `--lan-db` | `KEEL_DB_LAN=yes` | no | Open Postgres to your network too (connections from other machines then need TLS; see [Security](/self-hosting/security#postgres-connections)). |
| `--yes` | `KEEL_YES=1` | | Don't ask questions; use the defaults. |

```bash
curl -fsSL @@SITE@@/install.sh | sudo bash -s -- --lan --host nas.local
curl -fsSL @@SITE@@/install.sh | sudo KEEL_VERSION=0.2.0 bash
```

### Run it again to update

Run the same command on a machine where Keel is installed and it updates Keel instead: it pulls the newest images (or the `--version` you pass), refreshes the compose file and the `keel` command and restarts the containers. Your settings and data are kept, and the previous five versions of `docker-compose.yml` and `.env` are kept as `*.bak.<date>`. If the new version doesn't start, it goes back to the previous compose file. See [Updating](/self-hosting/updating).

## Install by hand

If you'd rather not pipe a script into `bash`, set up the same files yourself. In an empty folder:

```bash
mkdir -p ~/keel && cd ~/keel
curl -fsSL @@SITE@@/docker-compose.yml -o docker-compose.yml
curl -fsSL @@SITE@@/keel.env.example -o .env
curl -fsSL @@SITE@@/keel-cli.sh -o keel && chmod 755 keel    # optional: the keel command
chmod 600 .env
```

Generate a set of passwords:

```bash
docker run --rm @@IMAGES@@/keel:latest generate-env
```

Open `.env` and fill in:

- `KEEL_PUBLIC_URL`: the address your apps use to reach the API, such as `http://192.168.1.20:8000`.
- `POSTGRES_PASSWORD`, `KEEL_SERVICE_PASSWORD`, `KEEL_SECRET`, `KEEL_DASHBOARD_PASSWORD`, `IMGPROXY_KEY` and `IMGPROXY_SALT`: the values `generate-env` printed.
- `KEEL_STUDIO_BIND`: `0.0.0.0` if you want to open Studio from other devices on your network; it's `127.0.0.1` (this machine only) in the example file.

Then start Keel:

```bash
docker compose up -d
```

Compose creates the `db`, `db-tls`, `storage`, `backups`, `functions` and `tunnel` folders next to `docker-compose.yml` on the first start. Open Studio at `http://<server>:3000` (or `http://localhost:3000` on the machine itself) and sign in as `admin` with your `KEEL_DASHBOARD_PASSWORD`.

## Build from source (if you have the source code)

A copy of Keel's source code can build the images itself instead of downloading them. In the source folder:

```bash
./keel init --url http://192.168.1.20:8000
./keel up
```

`./keel init` copies `.env.example` to `.env` with fresh random secrets, sets `KEEL_PUBLIC_URL` to the URL you pass (`--project NAME` names the first project), and prints your Studio login. Studio and Postgres listen on this machine only; `./keel init --lan` opens Studio to your network (`--lan-db` does the same for Postgres). `./keel up` builds three images, `keel:local`, `keel-functions:local` and `keel-postgres:local`, which takes a few minutes, and starts the stack. A source checkout keeps its data in Docker volumes rather than folders (see [below](#where-your-data-lives)). To use the published images instead of building, add `KEEL_IMAGE=@@IMAGES@@/keel:latest`, `KEEL_FUNCTIONS_IMAGE=@@IMAGES@@/keel-functions:latest` and `KEEL_DB_IMAGE=@@IMAGES@@/keel-postgres:latest` to its `.env`.

::: danger Don't re-run `init --force` on a working install
The database keeps the Postgres password it was created with. A new `.env` has a new password, and Keel can no longer log in to its own database.
:::

## Check that it's running

```bash
cd /opt/keel          # your install folder
sudo ./keel ps
curl http://localhost:8000/health    # {"status":"ok"}
```

Open Studio at `http://<server>:3000` and continue with the [Quickstart](/guide/quickstart#_3-open-studio).

## The services

`docker-compose.yml` defines these containers (the Compose project is called `keel`):

| Service | Image | Published port | What it does |
|---|---|---|---|
| `keel-db` | `keel-postgres` | 5432 | Postgres 17 with pgvector and PostGIS: one database per project plus Keel's own `keel` database. Requires TLS for connections from other machines. |
| `keel-db-tls` | `keel` | | Makes Postgres' self-signed TLS certificate on the first start, then idles. No network. |
| `keel-migrate` | `keel` | | Runs on every start: creates roles, applies schema upgrades to every project and creates the first project. The other Keel services start after it has finished. It then stays running, idle (in a source checkout it exits). |
| `keel-gateway` | `keel` | 8000 | The API entry point. Routes `/<project>/...` to the right service, checks API keys and adds CORS headers. |
| `keel-rest` | `keel` | | One PostgREST process per project (the REST API). |
| `keel-auth` | `keel` | | Sign-up, sign-in, sessions and the admin API for all projects. |
| `keel-storage` | `keel` | | Buckets and files for all projects. |
| `keel-imgproxy` | `darthsim/imgproxy:v3` | | Resizes images for storage's image transformations. |
| `keel-realtime` | `keel` | | WebSocket server for database changes, broadcast and presence. |
| `keel-functions` | `keel-functions` | | Edge functions: one Deno process per function, on demand. |
| `keel-egress` | `keel` | | Sends the HTTP requests your SQL queues: [webhooks and `net.http_post`](/database/webhooks), often from [scheduled jobs](/database/cron). It has no superuser password and sits on a network of its own with the database and the gateway. |
| `keel-studio` | `keel` | 3000 | The Studio dashboard, its API, the nightly backups and scheduled jobs. |
| `keel-tunnel` | `keel` | | Runs a Cloudflare Tunnel once you paste a tunnel token in Studio (**Connect > Internet access**); idle until then. Only reaches the gateway and Studio. |
| `keel-docker` | `keel` | | A filtered window onto Docker so Studio can show this install's container status and logs and start, stop or restart them. Only Studio can reach it. |

Most services share the `keel` image; the container's command picks which service it runs. Every service has a Docker health check, so `./keel ps`, your NAS's dashboard and tools such as Portainer or Uptime Kuma show `healthy` or `unhealthy`. Only `keel-gateway` and `keel-studio` join the `keel-public` Docker network (named by `KEEL_PUBLIC_NETWORK`), so a tunnel container on that network (see [Internet access and HTTPS](/self-hosting/remote-access)) can reach those two and nothing else. The [architecture reference](/reference/architecture) explains how a request flows through the services.

## Where your data lives

**Installer, or the compose file set up by hand.** Everything is in the install folder (`/opt/keel`, `~/keel` or `/DATA/AppData/keel`):

| Path | Contents |
|---|---|
| `.env` | Your settings and passwords. |
| `docker-compose.yml` | The compose file. |
| `keel` | The [`keel` command](/self-hosting/cli). |
| `db/` | Postgres: every project's database and Keel's control database (projects, API keys, settings, edge function code and secrets). |
| `db-tls/` | Postgres' TLS certificate and key. Replace them with your own if you like. |
| `storage/` | Uploaded files. |
| `backups/` | Project backups (`pg_dump` files, nightly and manual) and, with full backups on, the encrypted full backups in `backups/full/`. |
| `credentials/` | The database password of each Keel service, written by `keel-migrate`. Each service reads only its own. |
| `tunnel/` | The Cloudflare Tunnel token, once you save one in Studio. |
| `functions/` | Working copies of deployed functions and Deno's module cache. Rebuilt from the database when needed. |

**Source checkout.** Settings are in `.env` in the source folder, and the data is in Docker volumes, prefixed with the Compose project name: `keel_keel-db`, `keel_keel-db-tls`, `keel_keel-storage`, `keel_keel-backups`, `keel_keel-functions` and `keel_keel-tunnel`, with the same contents as the folders above, plus one `keel_keel-cred-*` volume per service password. List them with `docker volume ls --filter name=keel_`.

Both survive `./keel down`, restarts and updates. See [Backups and restore](/self-hosting/backups) to copy them somewhere safe.

## Start, stop and check

| Command | What it does |
|---|---|
| `./keel up` | Pulls (or, in a source checkout, builds) the Keel images if needed, then starts or updates every container (`docker compose up -d`). |
| `./keel down` | Stops and removes the containers. Your data stays. |
| `./keel ps` | Shows each container and its status. |
| `./keel logs` | Follows the logs of every service. `./keel logs keel-auth` follows one. |

Run these from the install folder. If you installed with `sudo`, the settings file belongs to root, so run them with `sudo` too (`sudo ./keel ps`). Plain Compose commands work in the folder as well, for example `docker compose restart keel-auth` or `docker compose stop`. The [keel CLI](/self-hosting/cli) page lists every command.

::: tip After editing `.env`, run `./keel up`
`docker compose restart` keeps a container's old settings. `./keel up` (or `docker compose up -d`) recreates the containers whose settings changed.
:::

## Start on boot

Every long-running service has `restart: unless-stopped`. When the machine reboots, Docker starts them again, as long as Docker itself starts at boot:

```bash
sudo systemctl enable docker    # most Linux distributions
```

Containers you removed with `./keel down` stay down until you run `./keel up` again.

## Uninstall

To stop Keel and keep your data, so you can start it again later, run this in the install folder:

```bash
sudo ./keel down
```

To delete Keel **and all of its data**, stop it, then delete the install folder:

```bash
cd /opt/keel && sudo ./keel down
cd / && sudo rm -rf /opt/keel
```

In a source checkout, `./keel down -v` deletes the data volumes instead (same as `docker compose down -v`).

::: danger This deletes everything
Deleting the folder (or `down -v` in a source checkout) removes every project's database, users, uploaded files, backups and your settings. It can't be undone. Download the backups you want to keep from Studio first, or make a [full backup](/self-hosting/backups#full-backups).
:::

Then remove the images if you like:

```bash
docker image rm @@IMAGES@@/keel:latest @@IMAGES@@/keel-functions:latest @@IMAGES@@/keel-postgres:latest
```


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
