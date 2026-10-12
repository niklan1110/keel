# Windows

Keel runs on Windows 10 and 11 with [Docker Desktop](https://www.docker.com/products/docker-desktop/). The Windows installer is a PowerShell script: no WSL terminal, Git Bash or admin rights needed. It sets Keel up in a folder in your user folder, keeps your settings and passwords there, and installs the `keel` command for starting, stopping, updating and rolling back.

```powershell
irm @@SITE@@/install.ps1 | iex
```

When it's done:

| | |
|---|---|
| **Studio** | `http://localhost:3000`, on this PC only (see [Open Studio to your network](#open-studio-to-your-network)) |
| **API for your apps** | `http://<this PC's IP>:8000/<project>`, open to your network |
| **Postgres** | `localhost:5432`, on this PC only |
| **Settings** | `%USERPROFILE%\keel\.env` (readable by you and administrators only) |
| **Data** | `%USERPROFILE%\keel` and the Docker volume `keel_db` (see [Where your data lives](#where-your-data-lives)) |

## Before you start

1. **Install Docker Desktop** and keep its default, the **WSL 2 based engine** (Settings > General). The Docker Desktop installer sets up WSL 2 for you; it may ask you to restart.
2. **Start Docker Desktop** and wait until it says *Engine running*. It must run **Linux containers**, the default. If its menu offers *Switch to Linux containers*, choose that.
3. Give Docker Desktop enough memory: Keel wants **4 GB or more** for Docker (Settings > Resources, or the WSL settings app on recent versions). See [Requirements](/self-hosting/requirements).

Ports 8000 (API), 3000 (Studio) and 5432 (Postgres) must be free. A Postgres you installed on Windows usually holds 5432; the installer tells you, and `-DbPort 5433` picks another.

## Install

Open **PowerShell** (Start menu, type *PowerShell*; no need to run it as administrator) and run:

```powershell
irm @@SITE@@/install.ps1 | iex
```

The installer:

1. checks that Docker Desktop runs Linux containers and that the ports are free;
2. downloads Keel's compose files and the `keel` command into `%USERPROFILE%\keel`, and checks each file against the published SHA-256 checksums before using it;
3. downloads the Keel images for one exact version (the newest release unless you choose one);
4. writes `.env` with random passwords, your PC's network address in `KEEL_PUBLIC_URL`, and Studio and Postgres on this PC only, then locks the file to your account;
5. starts Keel, waits until Studio answers and prints your login.

```text
Keel is running.

  Studio (dashboard):  http://localhost:3000   (this PC only; run again with -Lan to open it to your network)
  Sign in:             admin / <generated password>
  API for your apps:   http://192.168.1.30:8000/my-app
  Settings:            C:\Users\you\keel\.env   (passwords; keep a copy somewhere safe)
  Data:                C:\Users\you\keel\{storage,backups,functions,tunnel} and the Docker volume keel_db
```

Open Studio, change your password and turn on two-factor authentication under **Account and security**. Keep a copy of `.env` somewhere safe, such as a password manager: it holds the passwords you need to restore a backup.

If **Windows Firewall** asks whether Docker Desktop may accept connections, allow **private networks**, so phones and other computers on your network can reach the API.

### Check the installer first

`irm | iex` runs whatever the website sends, checked only by HTTPS. To read the installer before running it, download it with its checksum, and run it only if they match:

```powershell
Invoke-WebRequest @@SITE@@/install.ps1 -OutFile install.ps1 -UseBasicParsing
Invoke-WebRequest @@SITE@@/install.ps1.sha256 -OutFile install.ps1.sha256 -UseBasicParsing
if ((Get-FileHash install.ps1).Hash -eq (Get-Content install.ps1.sha256).Split(' ')[0]) {
  powershell -ExecutionPolicy Bypass -File .\install.ps1
} else { 'install.ps1 does not match its checksum: do not run it' }
```

The checksum comes from the same website, so it catches a broken or cut-off download, not a website that was tampered with. For a check that doesn't depend on the website, use the copy attached to a [GitHub release](https://github.com/@@REPO@@/releases), which installs exactly that version, and check its build attestation with the GitHub CLI: `gh attestation verify install.ps1 --repo @@REPO@@`. `-ExecutionPolicy Bypass` applies to that one PowerShell process only; it doesn't change your PowerShell settings.

### Options

Pass options after `install.ps1` when you run the file, or set the environment variable first when you use `irm | iex`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Lan -Version 0.2.0
$env:KEEL_LAN = 'yes'; irm @@SITE@@/install.ps1 | iex
```

| Option | Variable | Default | What it does |
|---|---|---|---|
| `-Dir DIR` | `KEEL_DIR` | `%USERPROFILE%\keel` | Where to install: a full path on a local drive, outside OneDrive. The installer limits a new or empty folder to you, SYSTEM and administrators; a folder that already holds other files keeps its permissions. |
| `-Version V` | `KEEL_VERSION` | the newest release | Version to install or update to, such as `0.2.0`. |
| `-HostName HOST` | `KEEL_HOST` | this PC's IP address | The address part of `KEEL_PUBLIC_URL`, such as `mypc.local` or a Tailscale name. |
| `-Url URL` | `KEEL_PUBLIC_URL` | `http://<HOST>:8000` | The full address apps use, such as `https://api.example.com` behind a tunnel. |
| `-Lan` / `-NoLan` | `KEEL_LAN=yes` / `no` | asked; no without a terminal | Open Studio to your network, or keep it on this PC. |
| `-LanDb` | `KEEL_DB_LAN=yes` | no | Open Postgres to your network too (connections then need TLS; see [Postgres](#postgres)). |
| `-GatewayPort`, `-StudioPort`, `-DbPort` | `KEEL_GATEWAY_PORT`, ... | 8000, 3000, 5432 | Other ports, when these are taken. |
| `-ProjectName NAME` | `KEEL_PROJECT_NAME` | `keel` | Docker Compose project name, for a second Keel on the same PC (with other ports). |
| `-Yes` | `KEEL_YES=1` | | Don't ask questions; use the defaults. |
| `-DryRun` | | | Check Docker, the ports and the downloads, and show what would be done, without changing anything. |
| `-Rollback` [`-Restore`] | | | Go back to the version before the last update (see [Update and roll back](#update-and-roll-back)). |

## The keel command

The install folder has `keel.cmd`, which runs the Windows version of the [`keel` command](/self-hosting/cli). It works in PowerShell and in the Command Prompt, whatever the PowerShell execution policy:

```powershell
cd $HOME\keel
.\keel ps                         # is everything running?
.\keel logs keel-auth             # follow a service's logs (Ctrl+C to stop)
.\keel down                       # stop Keel (data is kept)
.\keel up                         # start it again, and apply changes to .env
.\keel psql                       # psql in the default project's database
.\keel update                     # back up, move to the newest release, restart
.\keel version
```

The commands and options are the same as on Linux and macOS ([keel CLI](/self-hosting/cli)): `functions deploy`, `secrets`, `studio-user`, `keys`, `import-supabase`, `update`, `rollback` and `restore` all work. To deploy edge functions, run it by its path from your app's folder, next to `supabase\functions`:

```powershell
cd C:\code\my-app
& $HOME\keel\keel.cmd functions deploy --project my-app
```

`keel.cmd` passes its arguments through the Command Prompt, which treats `&`, `|`, `<`, `>`, `^` and `%` as its own even inside PowerShell quotes: `.\keel secrets set KEY='a&b'` would set `KEY=a` and run `b` as a command. Put values with those characters in a file and use `.\keel secrets set --env-file .\secrets.env`.

Docker Desktop starts Keel's containers again when it starts. To have Keel running after you sign in to Windows, turn on **Start Docker Desktop when you sign in** in its settings.

## Open Studio to your network

Run the installer again with `-Lan` (it updates the install and keeps your data), or edit `.env` in the install folder and set:

```ini
KEEL_STUDIO_BIND=0.0.0.0
```

then run `.\keel up`. Studio is then at `http://<this PC's IP>:3000` from other devices. Allow Docker Desktop through Windows Firewall on private networks if it asks.

## Postgres

Postgres listens on this PC only (`localhost:5432`). Database tools on the PC connect directly; see [Connecting directly](/database/connecting-directly).

Docker Desktop hides where a connection comes from: to Postgres, every connection to its port seems to come from Docker's own network. So when you open Postgres to your network (`-LanDb`, or `KEEL_DB_BIND=0.0.0.0`), Keel sets `KEEL_DB_GATEWAY=remote`, and every connection to the port, from this PC too, then needs TLS (`sslmode=require`) and can't sign in as `postgres`. See [Postgres connections](/self-hosting/security#postgres-connections).

## Where your data lives

| Path | Contents |
|---|---|
| `.env` | Settings and passwords. |
| `docker-compose.yml`, `docker-compose.windows.yml` | The compose files. `COMPOSE_FILE` in `.env` makes `docker compose` and `keel` use both. |
| `keel.cmd`, `keel-cli.ps1` | The `keel` command. |
| Docker volume `keel_db` | Postgres: every project's database and Keel's control database. |
| `db-tls\` | Postgres' TLS certificate and key, made on the first start. |
| `storage\` | Uploaded files. |
| `backups\` | Nightly database dumps, encrypted full backups (`backups\full`), and the dumps `keel update` takes first (`backups\pre-update`). |
| `functions\` | Working copies of edge functions and Deno's module cache. |

The database lives in a Docker volume, inside Docker Desktop's own Linux disk, rather than in the install folder: through Docker Desktop's file sharing, a database on a Windows drive is several times slower and less safe in a crash. Everything else stays in the folder, so Explorer and your backup tool see it.

::: warning Keep the volume
`docker compose down -v`, **Clean / Purge data** in Docker Desktop's troubleshooting screen, and uninstalling Docker Desktop delete the `keel_db` volume, and with it every database. The nightly dumps in `backups\` (and the files in `storage\`) are your copies: back up the install folder. `.\keel down -v` asks before it deletes the volume.
:::

To restore one project's dump, see [Backups and restore](/self-hosting/backups). To put back a [full backup](/self-hosting/backups#full-backups) (every database and uploaded file at once, for example on a new PC):

```powershell
.\keel restore --list                                  # full backups here and in the backup target
.\keel restore keel-20261003-030000.tar.age --verify   # check one, changing nothing
.\keel restore keel-20261003-030000.tar.age            # replace everything with it
.\keel restore D:\keel-20261003-030000.tar.age         # a backup file you copied over
```

The passphrase comes from `KEEL_BACKUP_PASSPHRASE` in `.env`, or is asked for. See [Disaster recovery](/self-hosting/backups#disaster-recovery).

## Update and roll back

Run the installer again, or in the install folder:

```powershell
.\keel update                     # the newest release
.\keel update --version 0.2.0     # a chosen version
```

Either way, Keel first dumps every database into `backups\pre-update\<time>`, then moves to the new images, restarts and waits until it answers. Running the installer again also refreshes the compose files and the `keel` command (checked against their checksums), and keeps the previous five `.env` and compose files as `*.bak.<time>`.

If the new version misbehaves:

```powershell
.\keel rollback                   # back to the version before
.\keel rollback --restore         # also put back the databases from before the update
```

`rollback` notices when the newer version upgraded the database schema and offers to restore the backup, since the older version can't run on the newer schema. The installer does the same with `-Rollback` (and `-Restore`). See [Updating](/self-hosting/updating).

## Uninstall

```powershell
cd $HOME\keel
.\keel down
docker volume rm keel_db          # deletes every database
```

Then delete the install folder. Keep `.env` and a recent dump from `backups\` if you might come back.

## WSL and Git Bash

You can also run the Linux installer in a WSL 2 terminal (Ubuntu): `curl -fsSL @@SITE@@/install.sh | sudo bash`. Keel then lives inside WSL in `/opt/keel`, where its database is fast too, and you manage it with the bash `keel` command there. Pick one way per PC: both use the Compose project name `keel`.

For a copy of the **source code**, use the bash `keel` command in Git Bash or WSL (`./keel init`, `./keel up`); the Windows `keel` command is for installed folders. Clone with Git's default settings: the repository keeps its scripts with Linux line endings on every platform.

## Troubleshooting

| Problem | Fix |
|---|---|
| **"can't talk to Docker"** | Start Docker Desktop and wait for *Engine running*, then run the installer again. |
| **"Docker Desktop runs Windows containers"** | Right-click the Docker icon and choose **Switch to Linux containers**. |
| **"port 5432 (Postgres) is already in use"** | Another program (often a Postgres installed on Windows) uses it. Run the installer with `-DbPort 5433` (or `-StudioPort`, `-GatewayPort`). |
| **"running scripts is disabled on this system"** | You ran a `.ps1` file directly. Use `.\keel` (it runs `keel.cmd`), or `powershell -ExecutionPolicy Bypass -File .\install.ps1`. |
| **Phones can't reach the API** | Allow Docker Desktop through Windows Firewall on private networks, and check that `KEEL_PUBLIC_URL` in `.env` uses the PC's network address, not `localhost`. If the PC's address changes, give it a fixed one in your router (a DHCP reservation). |
| **Keel is slow or a service keeps restarting** | Give Docker Desktop more memory (4 GB or more). |
| **Keel stops when the PC sleeps** | A sleeping PC takes your backend with it. Change the sleep settings if other devices rely on Keel. |

More in [Troubleshooting](/self-hosting/troubleshooting).


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
