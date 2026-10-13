# Choose a platform

Keel installs on Linux, Windows, macOS and the common NAS systems, anywhere Docker runs. This page compares the systems it installs on, so you can pick a guide, and covers the NAS app screens and small devices such as the Raspberry Pi.

::: tip Which one?
For apps that phones and other people rely on, use a machine that's always on: a Linux server or mini PC, or a NAS. A Mac or Windows PC is fine for building and trying things out. Whatever you pick, apps reach Keel the same way and you can [move later](/self-hosting/backups#disaster-recovery) with a full backup.
:::

The installers set it up the same way everywhere: one exact version of the published images, random passwords in an `.env` file, Studio and Postgres on the machine itself unless you choose otherwise, and the [`keel` command](/self-hosting/cli) for updates (with a backup first) and rollbacks. Each one checks every file it downloads against the published SHA-256 checksums.

| System | Guide | Install folder | Studio by default |
|---|---|---|---|
| Linux server or PC | [Linux (Docker Compose)](/self-hosting/docker) | `/opt/keel` (`~/keel` without `sudo`) | asked; this machine only on a cloud server |
| Windows 10 and 11 (Docker Desktop) | [Windows](/self-hosting/windows) | `%USERPROFILE%\keel` | this PC only |
| macOS (Docker Desktop, OrbStack, Colima) | [macOS](/self-hosting/macos) | `~/keel` | this Mac only |
| ZimaOS, CasaOS | [ZimaOS](/self-hosting/zimaos) | `/DATA/AppData/keel` | your network |
| Unraid 6.12 and 7 | [Unraid](/self-hosting/unraid) | `/mnt/user/appdata/keel` | your network |
| TrueNAS SCALE 24.10+ | [TrueNAS SCALE](/self-hosting/truenas) | `/mnt/<pool>/apps/keel` | your network |
| Synology DSM 7.2+ | [Synology](/self-hosting/synology) | `/volume1/docker/keel` | your network |
| Raspberry Pi, small NAS | [below](#raspberry-pi-and-small-nas) | as for Linux | asked |

## NAS app screens

Every NAS above can also run Keel from its own app screen (ZimaOS App Store, Unraid's Compose Manager, TrueNAS's *Install via YAML*, Synology's Container Manager, Portainer or Dockge) with one file, [`nas-docker-compose.yml`](@@SITE@@/nas-docker-compose.yml). It has every setting written into it, so it needs no `.env` next to it. Before you paste it:

1. replace `/DATA/AppData/keel` everywhere in it with your data folder (the table above), and
2. fill in the seven `CHANGE_ME` values (see [Unraid: Fill in the values](/self-hosting/unraid#fill-in-the-values)).

The data folder holds Postgres' files, its TLS key, uploads, backups and the tunnel token, and the compose file holds every password. Keep both where only administrators can reach them: not in a shared folder that other NAS users or SMB clients can open.

Installed that way, Keel has no `keel` command: update it from the app screen, and back up in Studio first. The installer is the better choice when you can open a terminal.

## Raspberry Pi and small NAS

Keel runs on a Raspberry Pi 4 or 5 with a **64-bit** OS, and on NAS devices with 1 to 2 GB of RAM. Two things help:

- **An SSD instead of the SD card**, for speed and so the card doesn't wear out.
- **The small-device settings**, which cap each container's memory (so one busy service can't push the machine into swap or get Postgres killed) and give Postgres, image resizing and edge functions smaller settings.

In your install folder:

```bash
curl -fsSL @@SITE@@/docker-compose.small.yml -o docker-compose.small.yml
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.small.yml' >> .env
./keel up
```

In a source checkout the file is already there: add `COMPOSE_FILE=docker-compose.yml:deploy/compose/docker-compose.small.yml` to `.env`. With `COMPOSE_FILE` set, `./keel` and plain `docker compose` commands in the folder use both files. (On Windows the list is separated by `;` and already names `docker-compose.windows.yml`: add `;docker-compose.small.yml` to the end of that line.)

The limits add up to about 1.3 GB at most; idle, Keel needs much less. If a service keeps restarting (`./keel ps`) or its log ends with "out of memory", raise its `mem_limit` in `docker-compose.small.yml`. The Postgres part is the `KEEL_DB_SETTINGS` line, which you can also set in `.env` on any machine:

```bash
KEEL_DB_SETTINGS=shared_buffers=64MB work_mem=2MB max_wal_size=256MB
```
