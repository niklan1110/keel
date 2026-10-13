# Synology

Keel runs on Synology NAS models with an x86-64 or 64-bit ARM CPU and **DSM 7.2** or newer, through **Container Manager**. Two ways to install it:

- **The installer** over SSH (recommended): one command, settings in an `.env` file, and the [`keel` command](/self-hosting/cli) for updates with a backup first and rollbacks.
- **A Container Manager project**: paste Keel's compose file in DSM's web interface, no SSH needed.

Either way Keel keeps its data in `/volume1/docker/keel` (the `docker` shared folder).

## Before you start

1. Install **Container Manager** from the Package Center. It creates the `docker` shared folder on your first volume.
2. Your NAS needs **4 GB of RAM or more** (many models take a memory upgrade). See [Requirements](/self-hosting/requirements).
3. Ports **8000** (API) and **3000** (Studio) must be free.

## Option A: the installer (recommended)

1. Turn on SSH: **Control Panel > Terminal & SNMP > Enable SSH service**.
2. Sign in as an administrator (`ssh <admin-user>@<nas>`) and run:

   ```bash
   curl -fsSL @@SITE@@/install.sh | sudo bash
   ```

Keel goes into `/volume1/docker/keel` (the first volume that exists), not onto DSM's small system partition. Studio opens at `http://<nas>:3000` from your network. You can turn SSH off again afterwards.

Container Manager shows Keel's containers. Start, stop and update them with the `keel` command so the settings in `.env` apply:

```bash
cd /volume1/docker/keel
sudo ./keel ps            # is everything running?
sudo ./keel update        # back up, move to the newest release, restart
sudo ./keel rollback      # back to the version before the last update
```

## Option B: Container Manager project

1. **Make the passwords.** With SSH, run this once and keep the output:

   ```bash
   sudo docker run --rm @@IMAGES@@/keel:latest generate-env
   ```

   Without SSH, use a password generator: four random strings of letters and digits, 32 characters each, for the database password, the service password, the Keel secret and your Studio password, and two random strings of 64 hex characters (0-9, a-f) for the image-resize key and salt.
2. In **File Station**, create the folder `keel` in the `docker` shared folder.
3. **Get the compose file.** Open [`nas-docker-compose.yml`](@@SITE@@/nas-docker-compose.yml), copy all of it into a text editor, and replace every `/DATA/AppData/keel` with `/volume1/docker/keel`.
4. **Fill in the seven `CHANGE_ME` values**: the passwords and keys, and your NAS's IP address in `KEEL_PUBLIC_URL` (the table is in [Unraid: Fill in the values](/self-hosting/unraid#fill-in-the-values); it's the same file).
5. In **Container Manager > Project**, click **Create**. Name it `keel`, set the path to `/docker/keel`, choose **Create docker-compose.yml** and paste your edited file. Skip the Web Station step and click **Done**.
6. When the project is running, open Studio at `http://<nas>:3000` and sign in as `admin` with your dashboard password.

Your settings, passwords included, are in that compose file (`/volume1/docker/keel/docker-compose.yml`); keep a copy. To update, back up in Studio first, then in **Project**, select `keel`, **Action > Build** (it pulls new images and recreates the containers). When Keel's compose file changes, edit the project's YAML with the new file and your values.

## Firewall and HTTPS

- If the DSM firewall is on (**Control Panel > Security > Firewall**), allow ports 3000 (Studio) and 8000 (API) from your network.
- For HTTPS on your own domain, DSM's reverse proxy works (**Control Panel > Login Portal > Advanced > Reverse Proxy**): source `https://api.example.com`, destination `http://localhost:8000`, and under **Custom Header**, **Create > WebSocket** so realtime works. Add the proxy to `KEEL_TRUSTED_PROXIES` as `host` (see [Configuration](/self-hosting/configuration)). Or use a [Cloudflare Tunnel](/self-hosting/cloudflare-tunnel), which needs no open ports.

## Backups

Keel dumps every database to `/volume1/docker/keel/backups` each night, and uploads live in `storage/` next to it. Include the `docker/keel` folder in **Hyper Backup**, or take **Snapshot Replication** snapshots of the `docker` shared folder (Btrfs volumes). See [Backups and restore](/self-hosting/backups).


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
