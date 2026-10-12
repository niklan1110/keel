# TrueNAS SCALE

Keel runs on TrueNAS SCALE 24.10 (Electric Eel) and newer, which run apps on Docker. Two ways to install it:

- **The installer** in the TrueNAS shell (recommended): one command, settings in an `.env` file, and the [`keel` command](/self-hosting/cli) for updates with a backup first and rollbacks. Keel runs as a Compose project of its own, so the **Apps** page doesn't list it.
- **Install via YAML**: paste Keel's compose file as a custom app. It then shows on the **Apps** page, where you start, stop and update it.

Either way, Keel's data belongs on a pool, never on the boot pool.

## Before you start

1. **Set up Apps.** Open **Apps**; if TrueNAS asks, choose the pool for apps. Docker runs from then on.
2. **Create a dataset for Keel**, for example `tank/apps/keel` (**Datasets > Add Dataset**, preset *Apps*). Its path is `/mnt/tank/apps/keel`; use your pool's name instead of `tank`.
3. Ports **8000** (API) and **3000** (Studio) must be free.
4. 4 GB of RAM or more for Keel, on top of what ZFS and your other apps use. See [Requirements](/self-hosting/requirements).

## Option A: the installer (recommended)

Open **System > Shell** and run:

```bash
curl -fsSL @@SITE@@/install.sh | sudo bash -s -- --dir /mnt/tank/apps/keel
```

Without `--dir`, the installer uses `/mnt/<pool>/apps/keel` when there is one pool, and asks which one when there are several. It opens Studio to your network, keeps Postgres on the NAS, starts Keel and prints your login. Studio is at `http://<nas>:3000`.

Manage Keel with the `keel` command:

```bash
cd /mnt/tank/apps/keel
sudo ./keel ps            # is everything running?
sudo ./keel update        # back up, move to the newest release, restart
sudo ./keel rollback      # back to the version before the last update
```

Keel's containers start with Docker after a reboot. Check `docker compose version` first if the installer says Compose is missing.

## Option B: Install via YAML

1. **Make the passwords.** In **System > Shell**, run:

   ```bash
   sudo docker run --rm @@IMAGES@@/keel:latest generate-env
   ```

2. **Get the compose file.** Open [`nas-docker-compose.yml`](@@SITE@@/nas-docker-compose.yml) and copy all of it into a text editor.
3. **Point it at your dataset.** Replace every `/DATA/AppData/keel` with your dataset's path, such as `/mnt/tank/apps/keel`.
4. **Fill in the seven `CHANGE_ME` values**: the passwords and keys from step 1, and your NAS's IP address in `KEEL_PUBLIC_URL` (the table is in [Unraid: Fill in the values](/self-hosting/unraid#fill-in-the-values); it's the same file).
5. Open **Apps > Discover Apps**, click the **⋮** menu and choose **Install via YAML**. Name the app `keel`, paste your edited file and click **Save**.
6. When it shows as running, open Studio at `http://<nas>:3000` and sign in as `admin` with your dashboard password.

Your settings, passwords included, are in that YAML; keep a copy. To update, back up in Studio first, then use the app's **Update** button (or **Edit** and save to pull new images). When Keel's compose file changes, edit the app and paste the new file with your values.

## Notes

- **Snapshots**: a periodic snapshot task on the Keel dataset gives you point-in-time copies of everything. Keel's own nightly dumps in `backups/` are the safe way to restore the database itself (see [Backups and restore](/self-hosting/backups)).
- **Ports**: TrueNAS's web interface uses 80 and 443, which Keel leaves alone. If another app holds 3000 or 8000, change Keel's left-hand port numbers (installer: `KEEL_STUDIO_PORT`, `KEEL_GATEWAY_PORT` in `.env`, then `./keel up`).
- **HTTPS**: see [Internet access and HTTPS](/self-hosting/remote-access), or set up a [Cloudflare Tunnel](/self-hosting/cloudflare-tunnel) from Studio.


## Next steps

<div class="cards">
  <a class="card" href="../guide/quickstart#_3-open-studio"><strong>Finish the quickstart</strong><span>Open Studio, create a table and query it from your app.</span></a>
  <a class="card" href="./remote-access"><strong>Internet access and HTTPS</strong><span>Reach Keel away from home, privately or publicly.</span></a>
  <a class="card" href="./backups"><strong>Backups and restore</strong><span>Turn on encrypted full backups to a bucket off the machine.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>What to check before more people rely on your server.</span></a>
</div>
