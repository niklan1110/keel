# Updating

Keel is released as numbered versions (`0.2.0`, `0.3.0`, ...). An update moves your install from one version to the next: it backs up every database, pulls the new images and recreates the containers. Schema upgrades run by themselves when Keel starts, and if something goes wrong, `./keel rollback` takes you back.

```bash
cd /opt/keel && sudo ./keel update     # in your install folder
```

What changed in each version is in the [release notes on GitHub](https://github.com/@@REPO@@/releases). If you use Studio, it shows when a newer version is out (see [Update notices](#update-notices)).

## Installed with the installer

In the install folder (such as `/opt/keel`, `~/keel` or `/DATA/AppData/keel`), run:

```bash
sudo ./keel update                    # the newest release
sudo ./keel update --version 0.3.0    # a version of your choice
```

Leave out `sudo` if you installed without it. `./keel update`:

1. finds the newest release (or takes `--version`) and downloads its `keel` and `keel-functions` images, and `keel-postgres` when the compose file uses it. If that fails, nothing has changed;
2. dumps every database, each project and Keel's own `keel` database, from the running `keel-db` into `backups/pre-update/<date-time>/` in the install folder (the last three are kept). It stops if the disk is too full for them. `--no-backup` skips this;
3. writes the new version to `KEEL_VERSION` and the one it came from to `KEEL_PREVIOUS_VERSION` in `.env`;
4. adds settings the new version needs to `.env`, recreates the containers and waits until Keel answers.

It never goes to an older version; that's what [rolling back](#rolling-back) is for.

Or run the installer again, which does the same and also refreshes the compose file and the `keel` command (it saves the old ones as `*.bak.<date-time>` first):

```bash
curl -fsSL @@SITE@@/install.sh | sudo bash
```

imgproxy and the other third-party images are pinned in the compose file, so they change only with a new compose file: run the installer again after a release whose notes mention them.

::: info Moving to keel-postgres
In releases after 0.2.0, `keel-db` runs Keel's own `keel-postgres` image (Postgres 17 with [pgvector and PostGIS](/database/extensions)) instead of the plain `postgres:17-alpine` image. It's the same Postgres 17, so your data is used as it is. The switch comes with the new compose file: run the installer again (a plain `./keel update` keeps your compose file and the old image). `./keel rollback` to an older version keeps `keel-postgres` for the database (it sets `KEEL_DB_VERSION`), unless it restores the backup and the compose file from before the update.
:::

::: info Updating an install from before versioned releases
Installs from before October 2026 follow the moving `latest` tag. The first `./keel update` keeps the images you have as `previous` (so `./keel rollback` can go back to them) and from then on the install follows version numbers. The installer also moves Studio and Postgres to safer network defaults then: when `.env` doesn't set them, it keeps Studio on your network (`KEEL_STUDIO_BIND=0.0.0.0`), except on a cloud server, and moves Postgres to the machine itself (`KEEL_DB_BIND=127.0.0.1`), and prints what it did. Postgres also starts requiring TLS from other machines and refuses the `postgres` superuser from them; see [Postgres connections](/self-hosting/security#postgres-connections) if you connect from another machine.
:::

If you set up the compose file by hand and don't have the `keel` command, back up first (Studio: **Back up now** for each project), set `KEEL_VERSION` in `.env` to the new version, then run `docker compose pull && docker compose up -d` in its folder.

## Rolling back

To go back to the version you had before the last update:

```bash
sudo ./keel rollback
```

It switches `KEEL_VERSION` back to `KEEL_PREVIOUS_VERSION` and recreates the containers. If the newer version had upgraded the database schema, the older one can't run on it, so `rollback` asks whether to restore the backup taken just before the update:

```text
Since the backup of 2026-10-12T09:14:02Z (backups/pre-update/20261012-091402), the database schema changed:
the newer version upgraded it, so the older one can't run on it.
Restore every database from that backup? Changes made since then are lost. [y/N]
```

Restoring replaces every database (all projects and Keel's own) with the dumps, so anything written after the update is lost; a project created after the update is no longer listed. `./keel rollback --restore` restores without the schema check, `--yes` answers the question for you. The installer does the same with `--rollback` and `--rollback --restore`:

```bash
curl -fsSL @@SITE@@/install.sh | sudo bash -s -- --rollback --restore
```

The dumps are ordinary `pg_dump` files, so you can also restore one by hand (see [Backups and restore](/self-hosting/backups)). `globals.sql` next to them holds the database roles, for recovery by hand only.

### "This Keel is older than its database"

`keel-migrate` won't start an image older than the database, because older code doesn't know the newer schema and could damage data. That happens when you set an older `KEEL_VERSION` by hand, or roll back without restoring:

```text
This Keel (0.2.0, schema upgrades up to 10) is older than its database: project my-app has schema upgrade 12.
Starting it could damage your data, so Keel stops here. Either go back to the newer version
(./keel update, or set KEEL_VERSION back to it), or restore the backup taken before the update
with ./keel rollback --restore.
```

Keel's other services wait for `keel-migrate`, so nothing else starts. Do one of the two things it says.

## ZimaOS App Store

A custom app doesn't update itself from the store, and has no `keel` command. Back up each project in Studio first.

::: warning Releases after 0.2.0 need the new compose file
They add the `keel-egress` service and move `keel-db` to the `keel-postgres` image. A plain `docker compose pull` keeps the old Postgres image and has no `keel-egress`, so pgvector, PostGIS, webhooks and `net.http_*` don't work. Import the new compose file, or at least change `keel-db`'s image to `@@IMAGES@@/keel-postgres:latest`.
:::
 To get a new compose file (with new services or settings), import the new [`zimaos-docker-compose.yml`](@@SITE@@/zimaos-docker-compose.yml) again with your values (see [ZimaOS](/self-hosting/zimaos#updating)). For new images only, change the version in its image lines (see [Pin a version](#pin-a-version)), then in the folder that holds its compose file (see [Where is my compose file?](/self-hosting/zimaos#option-b-app-store-custom-app)) run:

```bash
docker compose pull && docker compose up -d
```

## Built from source

In a source checkout, `./keel update` backs up every database into `backups/pre-update/` (ignored by git), runs `git pull --ff-only` (if the folder is a git clone), then `./keel up`, which:

- **builds** the `keel`, `keel-functions` and `keel-postgres` images from the new code (the default), or
- **pulls** `KEEL_IMAGE`, `KEEL_FUNCTIONS_IMAGE` and `KEEL_DB_IMAGE` if you set them in `.env` to published images,

and then recreates the containers. To follow releases rather than the newest code, check out a version tag (`git checkout v0.2.0`) and run `./keel up`. `./keel rollback --restore` restores the databases from the last backup; then check out the code you had before and run `./keel up`. Keep your settings in `.env` rather than editing tracked files such as `docker-compose.yml`, or `git pull --ff-only` stops with a conflict. Put your own Compose changes in a `docker-compose.override.yml` instead.

## Behind your own reverse proxy

Keel believes the visitor's address in `X-Forwarded-For` only from proxies it trusts (see [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies)). Older versions believed any proxy on your network. If you run Nginx Proxy Manager, Traefik, Caddy or another reverse proxy in its own container or on another machine, every visitor now counts as that proxy: one set of rate limits for everyone, and Studio treats them all as the internet. After updating, look for this warning in the logs:

```text
172.20.0.5 forwards requests for others (X-Forwarded-For) but isn't a trusted proxy ...
```

and add the proxy to `.env`: its container name if it's on Keel's networks, otherwise its address (`KEEL_TRUSTED_PROXIES=172.20.0.5` or `KEEL_TRUSTED_PROXIES=host` for one on this machine). Then run `./keel up`.

## Schema upgrades

`keel-migrate` runs every time the stack starts. It checks that the database isn't newer than the image (see above), creates any new roles, sets the service roles' passwords, applies pending schema upgrades to every project's database (tracked in each database's `_keel.migrations` table), notes the version that ran them in the `keel` database, and creates the first project on a fresh install. The other Keel services wait until it has finished. Check what it did with:

```bash
./keel logs keel-migrate
```

```text
keel-migrate-1  | 2026-10-03T09:14:02.118Z INFO  cluster ready
keel-migrate-1  | 2026-10-03T09:14:02.904Z INFO  upgraded project my-app migrations=1
keel-migrate-1  | 2026-10-03T09:14:02.921Z INFO  project crm is up to date
keel-migrate-1  | 2026-10-03T09:14:02.930Z INFO  migrations complete version=0.2.0
```

You never need to run migrations by hand. The upgrades change Keel's own schemas and settings (such as `auth`, `storage` and `realtime`); they don't change the data in your tables.

## Pin a version

Keel's images are published as `@@IMAGES@@/keel`, `@@IMAGES@@/keel-functions` and `@@IMAGES@@/keel-postgres` (releases after 0.2.0), for amd64 and arm64, with these tags:

| Tag | Points to |
|---|---|
| `0.2.0` | Exactly release 0.2.0. |
| `0.2` | The newest `0.2.x` release. |
| `1` | The newest `1.x` release (from 1.0 on). |
| `latest` | The newest release. |
| `edge` | The newest build of the default branch: untested by a release, for trying things out. |

All three images share the same tags. The installer and `./keel update` always write an exact version to `.env`, so an install changes version only when you update it. To choose one yourself:

::: code-group

```bash [Installer (.env)]
sudo ./keel update --version 0.2.0
# or run the installer again with --version 0.2.0
```

```yaml [ZimaOS App Store (compose file)]
# Change every image line that uses Keel's images, for example:
image: @@IMAGES@@/keel:0.2.0
image: @@IMAGES@@/keel-functions:0.2.0
image: @@IMAGES@@/keel-postgres:0.2.0   # releases after 0.2.0
```

```bash [From source (.env)]
KEEL_IMAGE=@@IMAGES@@/keel:0.2.0
KEEL_FUNCTIONS_IMAGE=@@IMAGES@@/keel-functions:0.2.0
KEEL_DB_IMAGE=@@IMAGES@@/keel-postgres:0.2.0   # releases after 0.2.0
```

:::

To follow `edge`, set `KEEL_VERSION=edge` in `.env`; `./keel update` then stays on it.

## Check what you run

Every image says its version and the commit it was built from:

```bash
docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' @@IMAGES@@/keel:latest
./keel version
```

Release images are signed with [cosign](https://docs.sigstore.dev/) using GitHub's identity for the release workflow (no key to trust), and carry an SBOM and build provenance. To check a signature:

```bash
cosign verify @@IMAGES@@/keel:0.2.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/@@REPO@@/\.github/workflows/release\.yml@refs/tags/v'
```

## Update notices

Studio shows the running version in **Project settings**, and "v0.3.0 available" next to it when a newer release is out. To know that, Studio asks GitHub's public API for the latest release of Keel's repository at most once a day, only while someone uses Studio, and only on a release build. The request carries no cookie, token, version, host name or install ID; GitHub sees only that this server's address asked. To turn it off, set in `.env`:

```bash
KEEL_UPDATE_CHECK=off
```

and run `./keel up`.
