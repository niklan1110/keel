# ZimaOS

ZimaOS (on a ZimaBoard, ZimaBlade, ZimaCube or any x86-64 PC) is a good home for Keel: it already runs Docker, keeps app data in `/DATA/AppData`, and is on all the time. These instructions use the published images, so nothing is compiled on the NAS. They also work on CasaOS.

```bash
# On the NAS, over SSH:
curl -fsSL @@SITE@@/install.sh | sudo bash
```

When it's done:

| | |
|---|---|
| **Studio** | `http://<nas-ip>:3000` |
| **API for your apps** | `http://<nas-ip>:8000/<project>` |
| **Postgres** | `127.0.0.1:5432`, on the NAS only (see [Postgres from other machines](#postgres-from-other-machines)) |
| **Settings** | `/DATA/AppData/keel/.env` |
| **Data** | `/DATA/AppData/keel` |

## Before you start

- ZimaOS on an x86-64 machine with **4 GB of RAM or more** (8 GB if the NAS also runs media apps). See [Requirements](/self-hosting/requirements).
- Free ports **3000** (Studio), **8000** (API) and **5432** (Postgres, on the NAS itself). If another app uses one, see [Troubleshooting](#troubleshooting) for how to give Keel another port.

## Find your NAS's IP address

Your apps reach Keel at the NAS's address on your network, for example `192.168.1.20`. You'll find it on the ZimaOS dashboard, or in your router's list of devices. Over SSH, run:

```bash
ip route get 1.1.1.1 | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}'
```

::: tip
`hostname -I`, which many Linux guides suggest, isn't supported on ZimaOS. Use the command above.
:::

## Option A: install over SSH (recommended)

1. In ZimaOS, open **Settings > Developer Mode** and turn on **SSH Access**. The same screen has a web terminal if you'd rather not use SSH.
2. Connect to the NAS:

   ```bash
   ssh <your-zimaos-user>@<nas-ip>
   ```

3. Run the installer:

   ```bash
   curl -fsSL @@SITE@@/install.sh | sudo bash
   ```

The installer downloads Keel's compose file and the `keel` command into `/DATA/AppData/keel`, writes your settings with random passwords and the NAS's IP address to `/DATA/AppData/keel/.env`, starts Keel, waits until Studio answers and prints your login. Studio is opened to your network (in a terminal the installer asks first; `--no-lan` keeps it on the NAS). Postgres stays on the NAS.

```text
Keel is running.

  Studio (dashboard):  http://192.168.1.20:3000
  Sign in:             admin / <generated password>
  API for your apps:   http://192.168.1.20:8000/my-app
  Settings:            /DATA/AppData/keel/.env   (passwords; keep a copy somewhere safe)
  Data:                /DATA/AppData/keel/{db,db-tls,storage,backups,functions,tunnel}
```

`.env` is readable by root only. Keep a copy of it somewhere safe, such as a password manager.

The installer takes options as flags after `bash -s --`, or as environment variables after `sudo`, for example `curl -fsSL @@SITE@@/install.sh | sudo bash -s -- --host nas.local`:

| Flag | Variable | Default | What it does |
|---|---|---|---|
| `--host HOST` | `KEEL_HOST` | The NAS's IP address | Address apps use to reach Keel, such as a hostname or Tailscale name. Goes into `KEEL_PUBLIC_URL` as `http://<KEEL_HOST>:8000`. |
| `--url URL` | `KEEL_PUBLIC_URL` | `http://<KEEL_HOST>:8000` | The full address, for example an HTTPS address in front of Keel. |
| `--dir DIR` | `KEEL_DIR` | `/DATA/AppData/keel` | Where to install. |
| `--version V` | `KEEL_VERSION` | the newest release | Image version, such as `0.2.0`. The exact version is written to `.env`. |
| `--no-lan` | `KEEL_LAN=no` | Studio on your network | Keep Studio on the NAS only (reach it through a tunnel). |
| `--lan-db` | `KEEL_DB_LAN=yes` | Postgres on the NAS only | Open Postgres to your network. |

Running the installer again on an installed system updates Keel: it backs up every database to `backups/pre-update/`, refreshes the compose file and the `keel` command, and moves to the newest release, leaving your settings and data alone. `--rollback` goes back. See all options in [Linux (Docker Compose)](/self-hosting/docker#options).

## Option B: App Store (custom app)

1. Open [`zimaos-docker-compose.yml`](@@SITE@@/zimaos-docker-compose.yml) in your browser and copy all of it. It's Keel's compose file for ZimaOS, with every setting written into the file.
2. In ZimaOS, open the **App Store**, choose **+ / Install a customized app**, then **Import**, and paste it.
3. Replace the seven `CHANGE_ME` values before installing:
   - In the `x-secrets` block at the top, the postgres password, service password, Keel secret and dashboard password: long random strings of letters and digits. To generate a set, run `docker run --rm @@IMAGES@@/keel:latest generate-env` in the web terminal (**Settings > Developer Mode**) and use its `POSTGRES_PASSWORD`, `KEEL_SERVICE_PASSWORD`, `KEEL_SECRET` and `KEEL_DASHBOARD_PASSWORD` lines. The Keel secret must be at least 32 characters, the two database passwords at least 12 and the dashboard password at least 8.
   - The image-resize keys `imgproxy-key` and `imgproxy-salt`: the `IMGPROXY_KEY` and `IMGPROXY_SALT` lines from the same output (64 hex characters each). They make sure only Keel's storage service can ask for resized images; the resizer refuses to start until they are set.
   - `KEEL_PUBLIC_URL`: `http://<nas-ip>:8000`.
4. Install. Keel appears on the dashboard, and its tile opens Studio. Sign in as `admin` with your dashboard password.

The database refuses to start while `POSTGRES_PASSWORD` still says `CHANGE_ME`. Your settings, including the passwords, are in the compose file; keep a copy of it. A custom app doesn't update itself from the store; see [Updating](#updating).

::: tip Where is my compose file?
An App Store install keeps its compose file in ZimaOS's own app folder, and it doesn't include the `keel` command. To find the file:

```bash
docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' \
  $(docker ps -q --filter label=com.docker.compose.service=keel-studio)
```

Run the Compose commands on this page in that file's folder (or with `docker compose -f <that file>`).
:::

## First steps

1. Open Studio at `http://<nas-ip>:3000`. A first project, `my-app`, already exists.
2. Open **Account and security** from the project switcher, change your password and turn on two-factor authentication (see [Accounts and sign-in](/studio/accounts)).
3. Click **Connect** for the API URL and keys, then use them in your app:

   ```js
   import { createClient } from '@supabase/supabase-js'

   const keel = createClient('http://192.168.1.20:8000/my-app', 'YOUR_ANON_KEY')
   ```

4. Moving from Supabase? **Project settings > Import from Supabase** copies tables, users, policies and files. See [Migrate from Supabase](/self-hosting/migrate-from-supabase).

To use Keel away from home, or from a web app served over HTTPS, see [Internet access and HTTPS](/self-hosting/remote-access).

## Where your data lives

Everything is in `/DATA/AppData/keel`, so it shows up in the Files app and can be included in your NAS backups:

| Path | Contents |
|---|---|
| `.env` | Settings and passwords (installer only; readable by root only). |
| `docker-compose.yml` and `keel` | The compose file and the [`keel` command](/self-hosting/cli) (installer only). |
| `db/` | Postgres: every project's database and Keel's control database. |
| `db-tls/` | Postgres' TLS certificate and key, made on the first start. |
| `storage/` | Uploaded files. |
| `backups/` | Nightly and manual database backups. |
| `functions/` | Working copies of edge functions and Deno's module cache. |

## Change settings

**Installed with the installer:** edit `/DATA/AppData/keel/.env`, then apply it:

```bash
cd /DATA/AppData/keel
sudo nano .env
sudo ./keel up
```

**Installed from the App Store:** settings are in the `x-keel-env` block at the top of the compose file. Edit it, then run `docker compose up -d` in its folder.

For example, set `TZ` to your time zone (such as `Europe/Berlin`) so the 03:00 nightly backup runs at 03:00 your time rather than UTC. Every setting is described in [Configuration](/self-hosting/configuration).

## Updating

**Installed with the installer:** run the installer again, or:

```bash
cd /DATA/AppData/keel && sudo ./keel update
```

**Installed from the App Store:** in the compose file's folder, run:

```bash
docker compose pull && docker compose up -d
```

That gets new images. When Keel's compose file itself changes (new services or settings), import the new [`zimaos-docker-compose.yml`](@@SITE@@/zimaos-docker-compose.yml) again and fill in the same values as before. Files from before October 2026 lack the two image-resize keys (`imgproxy-key`, `imgproxy-salt`) and the `keel-db-tls` service; generate the keys as in step 3 above. Files from 0.2.0 and before lack `keel-egress` and run `keel-db` on the plain Postgres image; import the new file to get webhooks, `net.http_*`, pgvector and PostGIS.

Schema upgrades run automatically when Keel starts. Click **Back up now** in Studio before a big update. See [Updating](/self-hosting/updating).

## Postgres from other machines

Postgres listens on the NAS only. To connect a database tool from your computer, the simplest way is an SSH tunnel: `ssh -L 5432:127.0.0.1:5432 <user>@<nas-ip>`, then connect to `localhost:5432`.

To open it to your network instead: installer, set `KEEL_DB_BIND=0.0.0.0` in `.env` and run `sudo ./keel up`; App Store, change Postgres' port line to `"0.0.0.0:5432:5432"`. Connections from other machines then need TLS (`sslmode=require`), and the `postgres` superuser is refused unless you also set `KEEL_DB_REMOTE_SUPERUSER=on` (in `.env`, or under `keel-db`'s `environment` in the App Store file). See [Postgres connections](/self-hosting/security#postgres-connections).

## Backups

- Every night at 03:00 (in the `TZ` time zone, UTC unless you change it), Keel saves a `pg_dump` of each project to `/DATA/AppData/keel/backups` and keeps the last 7. Studio lists them and can restore or download one.
- Uploaded files are in `/DATA/AppData/keel/storage`. They aren't part of the database dumps.
- Set `KEEL_BACKUP_PASSPHRASE` (in `.env`, or in the App Store compose file) to get a nightly [full backup](/self-hosting/backups#full-backups): every database and uploaded file in one encrypted file, which Studio can copy to an S3-compatible bucket off the NAS.
- To have everything (settings, database, backups and files), copy `/DATA/AppData/keel` to another disk or include it in your NAS backup job; for an App Store install, keep a copy of the compose file too. For a consistent copy of the live `db/` folder, stop Keel first, or rely on the nightly dumps for the database.

See [Backups and restore](/self-hosting/backups).

## Remove Keel

```bash
cd /DATA/AppData/keel && sudo ./keel down
```

For an App Store install, uninstall the app in ZimaOS instead. Your data stays in `/DATA/AppData/keel` until you delete that folder.

## Troubleshooting

| Problem | Fix |
|---|---|
| **"port is already allocated"** | Another app uses 3000, 8000 or 5432. Installer: add `KEEL_STUDIO_PORT=3001` (or `KEEL_GATEWAY_PORT`, `KEEL_DB_PORT`) to `/DATA/AppData/keel/.env` and run `sudo ./keel up` there; if you change the API port, change it in `KEEL_PUBLIC_URL` too. App Store: change the left-hand port number in the compose file, for example `"3001:3000"`, then `docker compose up -d`. |
| **`keel-db` exits with "set POSTGRES_PASSWORD in the compose file first"** | App Store install: a `CHANGE_ME` value is still in the compose file. Replace all seven. |
| **Studio shows no logs or can't restart containers** | The `keel-docker` service must be running. It gives Studio its view of Docker. |
| **Apps can't connect from other devices** | `KEEL_PUBLIC_URL` must use an address those devices can reach (the NAS's LAN IP, not `localhost`). |
| **Studio doesn't open from other devices** | Installer: `KEEL_STUDIO_BIND` in `.env` must be `0.0.0.0` (run `sudo ./keel up` after changing it). App Store: Studio's port line must be `"0.0.0.0:3000:3000"`. |
| **`keel-imgproxy` keeps restarting with "IMGPROXY_KEY expected to be hex-encoded"** | App Store install: replace `CHANGE_ME_IMGPROXY_KEY` and `CHANGE_ME_IMGPROXY_SALT` with the `IMGPROXY_KEY` and `IMGPROXY_SALT` values from `generate-env`. |

Read a service's logs in Studio under **Logs**, or over SSH:

```bash
cd /DATA/AppData/keel && sudo ./keel logs keel-auth
```

More fixes are in [Troubleshooting](/self-hosting/troubleshooting).


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
