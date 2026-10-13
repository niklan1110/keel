# Backups and restore

Keel backs up every night, in two ways: a backup of each project's database for undoing mistakes, and an encrypted full backup of the whole server for getting everything back after a dead disk. This page shows how to turn full backups on, copy them off the machine, restore after a disaster, and restore one project.

| | Project backups | Full backups |
|---|---|---|
| **What** | A `pg_dump` of one project's database | Every project's database, Keel's own settings, keys and Studio accounts, and every uploaded file |
| **For** | Undoing a mistake in one project: a dropped table, a bad migration | Getting a whole install back on a new machine after a dead disk, a stolen NAS or a fire |
| **Where** | `backups/<project>/` on the server | `backups/full/` on the server, and copied to an S3-compatible bucket somewhere else |
| **Encrypted** | No | Yes, with your passphrase |
| **Turned on** | Always | When `KEEL_BACKUP_PASSPHRASE` is set |
| **Restore with** | Studio, **Restore** | `./keel restore` (`.\keel restore` on Windows) |

::: tip The short version
Set `KEEL_BACKUP_PASSPHRASE` in `.env`, save that passphrase in your password manager, add a bucket in Studio > **Backups**, and click **Test connection**. Keel then puts a complete, encrypted copy of everything off the machine every night.
:::

## Full backups

A full backup is one file, `keel-<YYYYMMDD>-<HHMMSS>.tar.age`, holding:

- the control database (`keel`): projects, their API keys and JWT secrets, sign-in settings (SMTP, OAuth, SMS), edge functions and their secrets, Studio accounts, saved queries, server settings;
- every project's database: tables, data, views, functions, triggers, policies, auth users, storage buckets and file records, saved [defaults](/studio/defaults);
- every uploaded file (the `storage` folder, without unfinished resumable uploads);
- the database roles the dumps refer to (each project's owner role, roles you created yourself), without their passwords.

It doesn't hold your `.env` (or a ZimaOS App Store compose file), the Cloudflare tunnel token, Studio sign-in sessions, or the project backups in `backups/`. Keep a copy of `.env` in your password manager.

The databases are dumped first and the files copied right after, so every file a restored database refers to is in the backup. A file uploaded while the backup runs may be in it without a database record, which does no harm.

### Turn them on

Set a passphrase of 12 characters or more and restart Keel:

::: code-group

```bash [Installer]
cd /opt/keel        # your install folder, such as /DATA/AppData/keel on ZimaOS
sudo nano .env      # add: KEEL_BACKUP_PASSPHRASE=a long passphrase only you know
sudo ./keel up
```

```bash [From source]
nano .env           # add: KEEL_BACKUP_PASSPHRASE=a long passphrase only you know
./keel up
```

:::

On a ZimaOS App Store install, set `KEEL_BACKUP_PASSPHRASE` under `keel-studio`'s `environment` in the app's compose file. To keep the passphrase out of `.env`, put it in a file and point `KEEL_BACKUP_PASSPHRASE_FILE` at it (for example a Docker secret).

::: danger Keep the passphrase somewhere else
Without the passphrase a full backup can't be opened, by you or by anyone. Keel never writes it to a database, a log or a backup. Save it in your password manager, not only on the server.
:::

::: warning Treat the passphrase like the database superuser password
The passphrase is as powerful as `POSTGRES_PASSWORD`. A full backup holds every API key, JWT secret and Studio account, and a restore runs the SQL in its dumps as the Postgres superuser. So anyone who has the passphrase and can put a file in your bucket (or in `backups/full/`) could hand you a backup that does whatever they wrote into it, if you restore it. Use a long passphrase that you use nowhere else, share it with nobody who shouldn't run the server, and restore only backups you made. `./keel restore` warns when a file's name and the backup inside don't match.
:::

Full backups then run every night right after the project backups, at `KEEL_BACKUP_SCHEDULE` (default `03:00`, in the `TZ` time zone). Studio > **Backups** > **Back up everything now** makes one straight away. The newest `KEEL_BACKUP_KEEP_LOCAL` (default `2`) stay in `backups/full/` on the server; older ones are deleted there once a new one is made.

### Encryption

Full backups use the [age](https://age-encryption.org) file format with a passphrase: the passphrase is stretched with scrypt (work factor 2^18), and the file is sealed in 64 KiB chunks with ChaCha20-Poly1305. Any change to the file, a chunk cut off, moved or added, or a wrong passphrase is detected before anything is restored. Keel encrypts as it writes, so no unencrypted copy of the whole backup is ever on disk; the database dumps sit in a private folder next to it only while the backup runs.

Because it is the standard age format, you can open a backup without Keel, with the [age](https://github.com/FiloSottile/age) tool, and unpack it with any `tar`:

```bash
age -d keel-20261003-030000.tar.age > keel-backup.tar   # asks for the passphrase
tar xf keel-backup.tar      # manifest.json, db/<database>.dump, storage/...
```

The `.dump` files are standard `pg_dump` archives (custom format) that `pg_restore` reads.

### Copy backups off the machine

A backup on the same disk doesn't survive that disk. Keel uploads each full backup to an S3-compatible bucket: AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO or Garage on another machine, and most other object stores. It's encrypted before it leaves the server, so the storage provider only ever sees the encrypted file.

In Studio, open **Backups** (the **Last backup** line in the stack card) and fill in **Backup target**:

| Service | Endpoint | Region | Bucket name in the path |
|---|---|---|---|
| AWS S3 | `https://s3.<region>.amazonaws.com` | your bucket's region, such as `eu-central-1` | on |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` (shown on the bucket page) | such as `us-west-004` | on |
| Cloudflare R2 | `https://<account id>.r2.cloudflarestorage.com` | `auto` | on |
| Wasabi | `https://s3.<region>.wasabisys.com` | such as `eu-central-2` | on |
| MinIO, Garage | `http://<address>:<port>` on your network | `us-east-1` (or what you set) | on |

**Folder** is where in the bucket the backups go (default `keel`), so one bucket can hold several servers' backups. Create a key that may only work in that bucket (see [Protect the backups in the bucket](#protect-the-backups-in-the-bucket)). **Test connection** lists the folder, writes a small file and deletes it again (or says the key can't delete), without saving anything; **Save** keeps the settings. The secret key is stored encrypted in Keel's control database (with a key derived from `KEEL_SECRET`) and is never shown again; leave the field empty to keep it when you change something else.

You can set the target in `.env` instead, which wins over Studio's and is what `./keel restore` uses on a new machine before Studio has any settings:

```bash
KEEL_BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
KEEL_BACKUP_S3_REGION=eu-central-1
KEEL_BACKUP_S3_BUCKET=my-keel-backups
KEEL_BACKUP_S3_PREFIX=keel
KEEL_BACKUP_S3_ACCESS_KEY_ID=...
KEEL_BACKUP_S3_SECRET_ACCESS_KEY=...
# KEEL_BACKUP_S3_PATH_STYLE=off   # bucket in the host name instead of the path
```

Uploads go in 16 MiB parts, read from the file on disk, so a backup of any size uploads with little memory; a NAS with 1 GB of RAM is fine. A part that fails is tried again a few times. If the upload still fails, the backup shows **Upload failed** with the reason, and stays on the server.

::: details Other destinations: rclone, another disk, your NAS's own backup
Full backups are ordinary encrypted files in `backups/full/`, so any tool can copy them on: [rclone](https://rclone.org) to Google Drive, OneDrive, SFTP or WebDAV (`rclone copy /opt/keel/backups/full remote:keel`), `rsync` to another machine, or your NAS's own backup job (Hyper Backup, the ZimaOS backup app). Copy only `backups/full/`; the files there are already encrypted.
:::

### How many are kept

In the bucket, Keel keeps the newest backup of each of the last **7 days** and of each of the last **4 weeks**, and always the newest one. Change both numbers in Studio > **Backups** > **Schedule**. Old backups are removed after each upload, and only files named `keel-<date>-<time>.tar.age` in Keel's folder are ever deleted. On the server, the newest `KEEL_BACKUP_KEEP_LOCAL` stay.

How much space that takes: each full backup is about the size of your compressed databases plus all uploaded files, so with 4 GB of photos, 11 backups in the bucket take about 44 GB. Raise or lower the counts to fit.

### Protect the backups in the bucket

The key Keel uses sits on the server. If the server is broken into, whoever did it has the key too, and with delete rights they can wipe your backups along with the server. Give the backups a defence that doesn't depend on that key:

- **A key without delete rights.** Give Keel's key only list, read and write in the bucket (on AWS: `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`; on Backblaze B2: an application key with `listFiles`, `readFiles`, `writeFiles`; on R2: an object read and write token for that bucket, plus versioning below). Keel then can't remove old backups itself; **Test connection** says so, uploads still count, and you remove old backups with the bucket's lifecycle rules (for example, delete files older than 60 days).
- **Versioning.** With versioning on, overwriting or deleting a file keeps the earlier version, which you can bring back from the provider's console. Add a lifecycle rule that removes old versions after a while, or the bucket keeps growing.
- **Object Lock** (AWS S3, Backblaze B2, Wasabi, MinIO). Files can't be deleted or overwritten by anyone, Keel's key included, until a retention period you choose (such as 30 days) has passed. This is the strongest protection against ransomware; set it when you create the bucket.

Whichever you choose, check from time to time that the newest backup in the bucket is recent, and keep the provider account's own password and two-factor separate from the server.

## Disaster recovery

To bring Keel back on a new machine (or the same one, rebuilt) from a full backup:

::: info On Windows
The Windows `keel` command doesn't have `restore` yet, so restore a full backup into an install made with the bash installer: on Linux, a Mac, a NAS, or in a WSL 2 terminal on Windows (see [WSL and Git Bash](/self-hosting/windows#wsl-and-git-bash)).
:::

1. **Install Keel on the new machine.** A fresh, empty install, the same way as the first time (see [Install](/self-hosting/platforms)):

   ::: code-group

   ```bash [Linux, macOS, NAS]
   curl -fsSL @@SITE@@/install.sh | sudo bash
   ```

   ```powershell [Windows]
   irm @@SITE@@/install.ps1 | iex
   ```

   :::

   Use the same Keel version as the old server or a newer one; a backup from a newer Keel won't restore onto an older one. The CPU type doesn't matter: a backup from an x86-64 server restores onto a Raspberry Pi and the other way round.

2. **Give it the passphrase and, for a backup in a bucket, the target.** In the new install folder, add to `.env`:

   ```bash
   KEEL_BACKUP_PASSPHRASE=the passphrase the backup was made with
   KEEL_BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
   KEEL_BACKUP_S3_REGION=eu-central-1
   KEEL_BACKUP_S3_BUCKET=my-keel-backups
   KEEL_BACKUP_S3_PREFIX=keel
   KEEL_BACKUP_S3_ACCESS_KEY_ID=...
   KEEL_BACKUP_S3_SECRET_ACCESS_KEY=...
   ```

   Without `KEEL_BACKUP_PASSPHRASE`, `./keel restore` asks for it. If you have the old server's `.env`, also copy its `KEEL_SECRET` line over (see below); leave the other passwords as the new install made them.

3. **Pick a backup.**

   ::: code-group

   ```bash [Linux, macOS, NAS]
   sudo ./keel restore --list
   ```

   ```powershell [Windows]
   .\keel restore --list
   ```

   :::

   This shows the full backups in `backups/full/` and in the bucket. For a file you copied over yourself, use its path instead of a name in the next step.

4. **Restore it.**

   ::: code-group

   ```bash [Linux, macOS, NAS]
   sudo ./keel restore keel-20261003-030000.tar.age
   ```

   ```powershell [Windows]
   .\keel restore keel-20261003-030000.tar.age
   ```

   :::

   Keel downloads the backup into `backups/full/` if needed, decrypts and checks all of it (a wrong passphrase or a damaged file stops here, with nothing changed), asks you to confirm, stops Keel, replaces every database and every uploaded file with the backup's, removes projects the backup doesn't have, and starts Keel again.

5. **Check it.** Sign in to Studio and look at your projects, tables and files.

   - Your apps keep working: the projects have the same API keys and JWT secrets, and users keep their passwords and stay signed in.
   - Studio has the accounts from the backup. The owner account (`KEEL_DASHBOARD_USERNAME`) signs in with the new install's `KEEL_DASHBOARD_PASSWORD`; other accounts keep their passwords.
   - Two-factor sign-in for Studio accounts and a backup target saved in Studio are sealed with `KEEL_SECRET`. With the old server's `KEEL_SECRET` in `.env` they keep working; with a new one, reset two-factor with `./keel studio-user reset-2fa <name>` and enter the target's secret key again in Studio.
   - Paste the Cloudflare tunnel token again (**Connect** > **Internet access**), if you used one, and update `KEEL_PUBLIC_URL` if the address changed (see [Configuration](/self-hosting/configuration#keel-public-url)).
   - Roles you created yourself come back without a login; give them a password again (`alter role ... login password '...'`).

6. **Turn backups on again** for the new server: the passphrase is already in `.env`; check the target in Studio > **Backups** and click **Test connection**.

`./keel restore <name> --verify` does steps 3 and 4 up to the check, without changing anything: a good way to test a backup now and then.

::: warning A restore replaces everything
Restoring a full backup onto a server that is in use throws away everything written there since the backup: new users, rows, files and projects. To roll back one project, use its project backup in Studio instead.
:::

## Project backups

Every night, before the full backup, Keel saves a `pg_dump` of each project's database:

```bash
# What the nightly job runs for each project (custom format, compressed):
pg_dump --format=custom --compress=6 --exclude-schema=_keel_defaults \
  --file my-app/my-app-20261003-030000.dump --dbname my_app
```

- **When:** every day at `KEEL_BACKUP_SCHEDULE` (default `03:00`), in the time zone set by `TZ` (default `UTC`). Studio > **Backups** > **Schedule** changes the time without a restart. `off` turns nightly backups (both kinds) off.
- **How many:** the last `KEEL_BACKUP_RETENTION` (default `7`) nightly backups per project are kept. Manual ones are kept until you delete them.
- **Where:** in the `backups` folder of your install folder (such as `/opt/keel/backups` or `/DATA/AppData/keel/backups`), or the `keel_keel-backups` volume of a source checkout, as `<project>/<project>-<YYYYMMDD-HHMMSS>.dump`.

They cover the project's database only: not its uploaded files, API keys, sign-in settings or edge functions, and they aren't encrypted. A backup that fails shows up in Studio as **Failed** with the error, and the `keel-studio` log has the details.

### Back up now, download, restore

Click **Back up now** in the stack card in Studio's side panel to dump the current project. Click the **Last backup …** line to open **Backups** for it. Each backup shows its time, whether it was **Nightly** or **Manual**, and its size:

- **Download** saves the `.dump` file, a standard `pg_dump` archive you can restore with `pg_restore` anywhere.
- **Restore** rolls the project's database back to that backup. Type the project name to confirm. Keel runs `pg_restore --clean --if-exists --single-transaction`, so a restore that fails leaves the database as it was. Everything written since the backup is lost, including new users. Uploaded files aren't touched: files uploaded since stay on disk without records, and files deleted since don't come back.
- **Delete** removes the backup file.

::: tip Saved defaults
A project's [defaults](/studio/defaults) aren't part of its project backups, and restoring one leaves them as they are. **Restore defaults** makes a backup first, marked **Before restoring defaults**, so you can undo it here.
:::

### One project onto another server

To move a single project, or when you only have a `.dump` file:

1. In Studio on the new server, create a project with the same name (**New project** in the project switcher).
2. Copy the `.dump` file to the server and restore it from the install folder:

   ```bash
   sudo docker compose exec -T keel-db pg_restore -U postgres \
     --clean --if-exists --single-transaction --exit-on-error \
     -d my_app < my-app-20261003-030000.dump
   ```

3. Copy the project's files: the folder named after its database (such as `my_app`) from the old `storage` folder (or volume) into the new one.
4. The new project has **new API keys and a new JWT secret**. Update your apps with the keys from **Connect**; users keep their passwords but must sign in again. Set up sign-in settings, edge functions and their secrets again.

::: tip Imported from Supabase?
Objects imported from Supabase belong to a role named `keel_import_<database>`. Create it on the new server before restoring, or `pg_restore` stops with "role does not exist": run `./keel psql` and then `create role keel_import_my_app nologin;`. Full backups create it for you.
:::

## Copy the whole install folder

Instead of a full backup, you can stop Keel and archive its folders. This needs a machine with the same CPU type to restore onto, and the archive isn't encrypted (it holds `.env` with all passwords), so prefer full backups.

::: code-group

```bash [Installer]
cd /opt/keel        # your install folder
sudo ./keel down
sudo tar czf ~/keel-full-$(date +%F).tgz --numeric-owner .
sudo ./keel up
```

```bash [From source]
./keel down
mkdir -p ~/keel-backup
for v in keel-db keel-storage keel-backups keel-functions; do
  docker run --rm -v keel_$v:/data -v ~/keel-backup:/out alpine tar czf /out/$v.tgz -C /data .
done
cp .env ~/keel-backup/
./keel up
```

:::

To restore, install Keel on the new machine, stop it, replace `db`, `storage`, `backups` and `functions` (or the volumes) and `.env` with the archive's, and start it: the database only accepts the passwords it was created with, so keep the old `.env`.

## Checklist

- `KEEL_BACKUP_PASSPHRASE` is set, and the passphrase is in your password manager.
- A backup target is set up, and **Test connection** passes. The newest full backup in Studio shows **Off-site**.
- The bucket has versioning or Object Lock, or Keel's key can't delete (see [Protect the backups in the bucket](#protect-the-backups-in-the-bucket)).
- `TZ` is your time zone, so the 03:00 run is at night for you.
- A copy of `.env` (or the ZimaOS App Store compose file) is in your password manager too, for `KEEL_SECRET`.
- Now and then, `./keel restore <name> --verify` opens the newest backup. Once, try a full restore on a spare machine or a virtual machine, so you know the steps work.
- Before a risky migration, click **Back up now**. (`./keel update` dumps every database itself first, into `backups/pre-update/`.)


## Next steps

<div class="cards">
  <a class="card" href="./updating"><strong>Updating</strong><span>Move to a new version, with a backup first and a way back.</span></a>
  <a class="card" href="./security"><strong>Security checklist</strong><span>Safe defaults, and what is left to you.</span></a>
  <a class="card" href="./troubleshooting"><strong>Troubleshooting</strong><span>When a backup fails or does not reach the bucket.</span></a>
</div>
