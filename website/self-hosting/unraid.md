# Unraid

Keel runs on Unraid 6.12 and 7 with Docker enabled. Two ways to install it:

- **The installer** in Unraid's web terminal (recommended): one command, settings in an `.env` file, and the [`keel` command](/self-hosting/cli) for updates with a backup first and rollbacks.
- **Compose Manager**: paste Keel's compose file into the plugin's stack editor and manage it from the **Docker** tab.

Either way Keel keeps its data in `/mnt/user/appdata/keel`.

## Before you start

- **Docker** is on (**Settings > Docker**), and your `appdata` share lives on a **cache pool** (an SSD), so the database is fast and doesn't wake the array's disks. In the share's settings, set the primary storage to the cache pool.
- Install the **Compose Manager** plugin (**Apps**, search for *Compose Manager*). It adds `docker compose`, which both ways need.
- Ports **8000** (API) and **3000** (Studio) must be free. If another container uses one, see [Ports](#ports).
- 4 GB of RAM or more. See [Requirements](/self-hosting/requirements).

::: info Why not a Community Applications template?
A Community Applications template describes one container. Keel is fourteen (one of them only makes a certificate at start) that start in order and share settings, so it ships as a Compose project instead, which Compose Manager (or the installer) runs as one app.
:::

## Option A: the installer (recommended)

Open the web terminal (the **>_** icon at the top right) and run, as root:

```bash
curl -fsSL @@SITE@@/install.sh | bash
```

It installs into `/mnt/user/appdata/keel` (it refuses folders outside `/mnt`, because everything else is gone after a reboot), opens Studio to your network, keeps Postgres on the server, starts Keel and prints your login. Studio is at `http://<server>:3000`.

Keel's containers appear in the **Docker** tab and start with Docker when the array starts. Manage them with the `keel` command so the settings in `.env` apply:

```bash
cd /mnt/user/appdata/keel
./keel ps                 # is everything running?
./keel update             # back up, move to the newest release, restart
./keel rollback           # back to the version before the last update
```

Options such as `--host tower.local` or `--version 0.2.0` go after `bash -s --`; see [installer options](/self-hosting/docker#options).

## Option B: Compose Manager

1. **Make the passwords.** In the web terminal, run:

   ```bash
   docker run --rm @@IMAGES@@/keel:latest generate-env
   ```

   Keep the output open; you'll paste values from it.
2. **Get the compose file.** Open [`nas-docker-compose.yml`](@@SITE@@/nas-docker-compose.yml) and copy all of it into a text editor.
3. **Point it at your share.** Replace every `/DATA/AppData/keel` with `/mnt/user/appdata/keel` (use your editor's replace-all).
4. **Fill in the seven `CHANGE_ME` values** in the `x-secrets` block and `KEEL_PUBLIC_URL`, as described in [Fill in the values](#fill-in-the-values).
5. In Unraid, open **Docker**, scroll to **Compose**, click **Add New Stack** and name it `keel`.
6. Click the gear next to the stack, choose **Edit Stack > Compose File**, paste your edited file and save.
7. Click **Compose Up**. When it's done, open Studio at `http://<server>:3000` and sign in as `admin` with your dashboard password. Turn on **Autostart** for the stack so Keel starts with the array.

Your settings, passwords included, are in that compose file: keep a copy of it somewhere safe.

### Fill in the values

| In the file | Value |
|---|---|
| `CHANGE_ME_POSTGRES_PASSWORD` | `POSTGRES_PASSWORD` from `generate-env` |
| `CHANGE_ME_SERVICE_PASSWORD` | `KEEL_SERVICE_PASSWORD` |
| `CHANGE_ME_KEEL_SECRET` | `KEEL_SECRET` |
| `CHANGE_ME_DASHBOARD_PASSWORD` | `KEEL_DASHBOARD_PASSWORD` (your Studio password) |
| `CHANGE_ME_IMGPROXY_KEY`, `CHANGE_ME_IMGPROXY_SALT` | `IMGPROXY_KEY` and `IMGPROXY_SALT` |
| `CHANGE_ME_NAS_IP` in `KEEL_PUBLIC_URL` | The server's IP address on your network, such as `192.168.1.10` |

Postgres refuses to start while a `CHANGE_ME` value is left.

### Updating

Back up in Studio first (**Back up now**). Then click **Update Stack** (or **Compose Pull**, then **Compose Up**) to get new images. When Keel's compose file itself changes (new services or settings, noted in the [changelog](https://github.com/@@REPO@@/blob/HEAD/CHANGELOG.md)), repeat steps 2 to 4 with the new file and your existing values, and paste it in again. See [Updating](/self-hosting/updating).

## Ports

Another container on 3000 or 8000? Installer: add `KEEL_STUDIO_PORT=3001` (or `KEEL_GATEWAY_PORT=8001`) to `/mnt/user/appdata/keel/.env` and run `./keel up`; if you change the API port, change it in `KEEL_PUBLIC_URL` too. Compose Manager: change the left-hand number of the port line, such as `"0.0.0.0:3001:3000"`, and **Compose Up**.

## HTTPS and remote access

If you already run a reverse proxy in Docker (Traefik, Nginx Proxy Manager, SWAG), see [Traefik](/self-hosting/remote-access#traefik) and [Internet access and HTTPS](/self-hosting/remote-access). A [Cloudflare Tunnel](/self-hosting/cloudflare-tunnel), set up from Studio, needs no open ports.

## Backups

Keel dumps every database to `/mnt/user/appdata/keel/backups` each night, and uploads live in `storage/` next to it. Include `/mnt/user/appdata/keel` in your appdata backup (for example the *Appdata Backup* plugin, which stops containers while it copies). See [Backups and restore](/self-hosting/backups).


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
