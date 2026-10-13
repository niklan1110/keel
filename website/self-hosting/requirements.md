# Requirements

Keel runs as a handful of containers on one machine with Docker. Anything from a Raspberry Pi to a NAS or a spare PC works, as long as it can run 64-bit Linux containers and stays on while your apps need it.

| | Minimum | Recommended |
|---|---|---|
| **Operating system** | Linux on x86-64 or arm64 | A server or NAS that's always on |
| **Docker** | Docker Engine with the Compose plugin, v2 or newer | The latest stable Docker |
| **Memory** | 1 to 2 GB free for Keel | A machine with 4 GB or more |
| **Disk** | A few GB for images, plus your data | Room to grow for data, uploads and backups |
| **Ports** | 8000 (API), 3000 (Studio), 5432 (Postgres) | Same, or your own choice |

## Operating system

**Linux** (x86-64 or arm64) is the home for a Keel server. Any distribution that runs a current Docker Engine works, as do NAS systems with Docker: ZimaOS, CasaOS, Synology (Container Manager), Unraid and TrueNAS SCALE. The installer picks the right data folder on each; see [Choose a platform](/self-hosting/platforms).

**macOS and Windows** work for development and testing with [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or [OrbStack](https://orbstack.dev) on a Mac). On a Mac, the installer and the `keel` command run in Terminal. On Windows, the [Windows installer](/self-hosting/windows) and its `keel` command run in PowerShell, with no WSL terminal or Git Bash needed. A laptop that sleeps isn't a good place for a backend that other devices rely on, so move to an always-on machine when you start using Keel for real.

## CPU architecture

The published images are built for `linux/amd64` and `linux/arm64`:

- **x86-64:** mini PCs, NAS devices (ZimaBoard, ZimaBlade, ZimaCube), servers, desktops.
- **arm64:** Raspberry Pi 4 and 5 with a **64-bit** OS, and other 64-bit ARM boards. 32-bit ARM systems aren't supported.

::: info ZimaOS is x86-64 only
ZimaOS has no ARM build, so a ZimaOS install is always x86-64. Keel's arm64 images are for other systems, such as Raspberry Pi OS (64-bit).
:::

The [installer](/self-hosting/docker) downloads the published images, so nothing is compiled on your machine. [Building from source](/self-hosting/docker#build-from-source-if-you-have-the-source-code) instead takes a few minutes on a PC and much longer on a Raspberry Pi.

## Software

For the [installer](/self-hosting/docker) you need:

- **Docker** with the **Compose plugin**. Check with `docker compose version`, which should print v2 or newer.
- **curl** and **bash**, for the installer and the `keel` command.
- Root access (`sudo`), or a user that can run `docker`.

ZimaOS and CasaOS already have all of these. On Windows, the [Windows installer](/self-hosting/windows) needs only Docker Desktop and the PowerShell that comes with Windows. Building from source also needs **openssl**, which `./keel init` uses to generate passwords, and **git** if `./keel update` should pull new code.

## Memory

Keel itself needs about **1 to 2 GB** of RAM: Postgres, the API services, Studio and a few small helpers. On top of that:

- Each **edge function** that's running adds about **40 MB**. A function's process starts on its first request and stops after 5 idle minutes, and each one may use up to 256 MB of heap (`KEEL_FUNCTIONS_MEMORY_MB`). At most 20 run at once (`KEEL_FUNCTIONS_MAX_WORKERS`).
- **Postgres** uses more memory as your data and the number of connections grow.

On a NAS that also runs other apps, use a machine with **4 GB or more** (8 GB if it also runs media apps such as Jellyfin or Immich). On a Raspberry Pi or a NAS with 1 to 2 GB, use the [small-device settings](/self-hosting/platforms#raspberry-pi-and-small-nas), which cap each container's memory.

## Disk

Plan for:

- **Images:** a few GB for Keel's three images (`keel`, `keel-functions` and `keel-postgres`, which is Postgres with pgvector and PostGIS) and the imgproxy image.
- **Database:** your tables, users and indexes.
- **Uploaded files:** stored as plain files, outside the database.
- **Backups:** one compressed `pg_dump` per project per night, 7 kept by default (`KEEL_BACKUP_RETENTION`), plus any manual backups. With full backups on, the newest 2 full backups (`KEEL_BACKUP_KEEP_LOCAL`), each about the size of the compressed databases plus all uploaded files, and about that much again while one is being made. A full backup needs about 256 MB of memory for a second while it derives the encryption key.
- **Function cache:** Deno's module cache for `npm:` and `jsr:` imports used by your edge functions.

An SSD makes Postgres noticeably faster than a spinning disk, but both work. On a Raspberry Pi, put Keel on an SSD rather than the SD card: Postgres writes constantly, which is slow on SD cards and wears them out.

## Network

Keel publishes three ports on the host:

| Port | Service | Who connects |
|---|---|---|
| **8000** | Gateway (the API) | Your apps, at `http://<server>:8000/<project>` |
| **3000** | Studio | You, in a browser |
| **5432** | Postgres | Migrations, ORMs, `psql`, BI tools |

The API listens on every network interface, so your apps and devices can reach it. Studio and Postgres listen on the machine itself only, unless you open them: the installer opens Studio to your network on a NAS or when you pass `--lan`, and asks elsewhere. You can change the port numbers and binds later: see [Configuration](/self-hosting/configuration#ports-and-network-binds). Keep 5432 off the internet in any case (see [Security](/self-hosting/security)).

Keel needs internet access to download its images, and edge functions download their `npm:` and `jsr:` imports the first time they start. Other outgoing connections happen only when you set them up: HTTP requests and [webhooks](/database/webhooks) from SQL, sign-in providers, your mail server, and full backups to an S3 bucket. Studio checks for a newer release once a day at most (`KEEL_UPDATE_CHECK=off` turns that off). Keel doesn't send usage data, and it only contacts Supabase if you run the [importer](/self-hosting/migrate-from-supabase).

## Next steps

<div class="cards">
  <a class="card" href="./docker"><strong>Docker Compose</strong><span>Install with one command on any Linux machine, or set up the compose file by hand.</span></a>
  <a class="card" href="./zimaos"><strong>ZimaOS</strong><span>One command over SSH, or a custom app in the App Store.</span></a>
  <a class="card" href="./windows"><strong>Windows</strong><span>A PowerShell installer for Docker Desktop, with the keel command.</span></a>
  <a class="card" href="./macos"><strong>macOS</strong><span>Docker Desktop, OrbStack or Colima.</span></a>
  <a class="card" href="./platforms"><strong>NAS and small devices</strong><span>Unraid, TrueNAS SCALE, Synology, NAS app screens and the Raspberry Pi.</span></a>
</div>
