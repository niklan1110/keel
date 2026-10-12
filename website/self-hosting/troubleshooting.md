# Troubleshooting

This page lists the problems people run into most, by symptom: installing and starting, Studio, apps and the API, features such as email, realtime, functions, jobs and backups, and a full disk. Most problems show up in a service's log, so start there. The [Windows](/self-hosting/windows#troubleshooting) and [macOS](/self-hosting/macos#troubleshooting) guides have extra tips for their systems.

```bash
cd /opt/keel                   # your install folder
sudo ./keel ps                 # is everything running?
sudo ./keel logs keel-auth     # follow one service's log (Ctrl+C to stop)
```

Run these in your install folder (such as `/opt/keel`, `~/keel` or `/DATA/AppData/keel`), with `sudo` if you installed with it. In Studio, open **Logs** in the dock and pick a service; type `WARN` or `ERROR` in the filter to see only problems. A ZimaOS App Store install has no `keel` command: run `docker compose logs -f keel-auth` in the folder of its compose file instead.

## Installing and starting

### "manifest unknown" or "unauthorized" when pulling images

- **manifest unknown:** the image or tag doesn't exist. Check the version in `KEEL_VERSION` (or the image lines of your compose file) against the tags in [Pin a version](/self-hosting/updating#pin-a-version), and that the image names match the ones in the compose file you downloaded.
- **unauthorized** or **denied:** Docker sent old or wrong registry credentials. If you once ran `docker login` for that registry, run `docker logout` for it and try again.
- **no matching manifest for linux/arm/v7:** you're on a 32-bit ARM system. Keel's images need a 64-bit OS (arm64 or x86-64).

### "port is already allocated"

`Bind for 0.0.0.0:3000 failed: port is already allocated` means another program already uses 3000, 8000 or 5432. Find it with `docker ps --filter publish=3000` (another container) or `sudo ss -ltnp | grep :3000`. Then either stop it or give Keel another port: `KEEL_STUDIO_PORT`, `KEEL_GATEWAY_PORT` or `KEEL_DB_PORT` in `.env`, then `./keel up`, or the port number after the address in a ZimaOS App Store compose file (`"0.0.0.0:3001:3000"`). If the installer stopped with this error, add the setting to the `.env` it wrote and run `./keel up` in the install folder. See [Ports and network binds](/self-hosting/configuration#ports-and-network-binds).

### "required variable POSTGRES_PASSWORD is missing a value"

Compose can't find your settings: there's no `.env` next to `docker-compose.yml`, it lacks the passwords, or you ran Compose from another folder. Run the commands in the install folder, and with `sudo` if you installed with it (`.env` is readable by its owner only). If you set Keel up by hand, fill in `.env` as described in [Install by hand](/self-hosting/docker#install-by-hand). In a source checkout, run `./keel init` (don't use `--force` on an existing install). A message about `KEEL_PUBLIC_URL` means the same for that setting.

### The database refuses a `CHANGE_ME` password

On a ZimaOS App Store install, `keel-db` exits right away with:

```text
keel: set POSTGRES_PASSWORD in the compose file first (it still says CHANGE_ME)
```

and the other services log "POSTGRES_PASSWORD still has its example value". Replace all seven `CHANGE_ME` values in the compose file (generate passwords with `docker run --rm @@IMAGES@@/keel:latest generate-env`), then `docker compose up -d`. A log line such as "KEEL_SECRET must be at least 32 characters long" means a value is too short; see [Secrets](/self-hosting/configuration#secrets).

### A service keeps restarting

`./keel ps` shows `Restarting`, or Studio's stack card shows a service as stopped. Read its log:

- **"password authentication failed for user"**: the passwords in `.env` don't match the database, usually after a new `.env` replaced the one the database was created with (`./keel init --force`, a reinstall, or a copied `.env`). Put the original `POSTGRES_PASSWORD` back (from your backup of `.env`).
- **Compose says `keel-migrate` didn't complete successfully, or is unhealthy**: the other services wait for `keel-migrate`, so its error stops everything. Run `./keel logs keel-migrate` to see why.
- **A secret error** ("not set", "example value", "at least … characters"): fix the value as described above.

### The installer says "Keel didn't start"

The installer waits up to five minutes for Studio to answer (on the `KEEL_STUDIO_PORT` from `.env`, or Docker's health checks of `keel-studio` and `keel-gateway`), then shows the containers and their last log lines. Read them for the cause, often one of the problems on this page; on a Raspberry Pi the first start can also just be slow. Fix it and run `./keel up` in the install folder. An update that fails this way has already put the previous compose file back; your earlier files are in the install folder as `docker-compose.yml.bak.*` and `.env.bak.*`.

## Studio

### Studio doesn't open from another device

Studio listens on the machine itself unless you opened it (the installer does on a NAS, or with `--lan`). Check `KEEL_STUDIO_BIND` in `.env`: `127.0.0.1` means this machine only. Set it to `0.0.0.0` and run `./keel up` to open it to your network, or keep it closed and use an SSH tunnel: `ssh -L 3000:127.0.0.1:3000 you@server`, then `http://localhost:3000`. On a ZimaOS App Store install, Studio's port line must be `"0.0.0.0:3000:3000"`.

### Studio login fails

"Wrong username or password" means the values don't match the ones Studio started with. Find them:

- **Installer:** `sudo grep KEEL_DASHBOARD .env` in the install folder (the username is `admin` unless the file sets `KEEL_DASHBOARD_USERNAME`)
- **ZimaOS App Store:** `grep KEEL_DASHBOARD` in the app's compose file
- **Source checkout:** `grep KEEL_DASHBOARD .env` in the source folder

If you changed your password in Studio, the `.env` value no longer works; use the one you chose. To get back in either way, change `KEEL_DASHBOARD_PASSWORD` in `.env` and recreate Studio (`./keel up`, or `up -d keel-studio`): Studio then resets the owner's password to it. Other accounts: `./keel studio-user reset-password <name>`.

Other messages:

- **"Too many sign-in attempts. Wait a few minutes."** 10 failed attempts from one address within 15 minutes (or 20 per hour per account from the internet). A successful sign-in resets the count for that address.
- **"Sign-ins from the internet need two-factor authentication."** You're connecting through the internet (a tunnel or public address) with an account that has no two-factor yet. Sign in from your home network or Tailscale and set it up under **Account and security**, or see [Sign-ins from the internet](/studio/accounts#sign-ins-from-the-internet). If you see it at home through a reverse proxy on the server (Caddy, nginx, `tailscale serve`), Keel doesn't trust that proxy yet: bind Studio's port to `127.0.0.1` (`KEEL_STUDIO_BIND=127.0.0.1`) or set `KEEL_TRUSTED_PROXIES=host`, then `./keel up`. See [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies).
- **"Studio doesn't answer to the name …" (421).** You opened Studio under a host name it doesn't know, such as a domain your router points at the server. Open it by IP address, or add the name to `KEEL_STUDIO_HOSTS` in `.env` and run `./keel up`.
- **Lost the phone with your authenticator app:** `./keel studio-user reset-2fa <name>` on the server (or ask another Studio account to **Reset 2FA** for you). See [Locked out](/studio/accounts#locked-out).

### Studio shows no logs or can't restart containers

Studio reaches Docker through the `keel-docker` service. Check that it's running (`docker compose ps keel-docker`) and that nothing turns container controls off: a `docker-compose.override.yml` that sets `DOCKER_HOST` to `off` (see [The Docker proxy](/self-hosting/security#the-docker-proxy)), or, in a source checkout, `KEEL_DOCKER_HOST=off` or an empty `KEEL_DOCKER_HOST=` in `.env`.

## Apps and the API

### "Invalid API key"

The gateway answers `401 {"message":"Invalid API key"}` when the `apikey` header isn't the anon or service role key of the project in the URL:

- The key belongs to a different project. Each project has its own keys.
- Keel was reinstalled, or the project was deleted and created again. That creates new keys; copy them again from **Connect**.
- The key was cut off when copying. Keys are long JWTs starting with `eyJ`.

"No API key found in request" means the `apikey` header is missing. "Invalid API key" with a key you just copied usually means the project name in the URL is wrong (a project that doesn't exist answers like a wrong key); the URL must include it, as in `http://192.168.1.20:8000/my-app`.

### CORS errors or "mixed content" in the browser

The gateway allows every origin, so a CORS error usually means the request never got a proper answer from Keel: the URL is wrong, Keel is down, or a proxy returned an error page. Open the URL in the browser's network tab to see the real response.

A page served over `https://` can't call an `http://` API: the browser blocks it as mixed content. Put Keel behind HTTPS and use that address. See [Internet access and HTTPS](/self-hosting/remote-access).

### A phone or another computer can't reach Keel

1. From that device, open `http://<server-ip>:8000/health` in a browser. It should show `{"status":"ok"}`.
2. If it doesn't load: check that the device is on the same network (guest Wi-Fi often isolates devices), that `KEEL_GATEWAY_BIND` isn't `127.0.0.1`, and that no firewall on the server blocks the port. On Windows, allow Docker Desktop through Windows Firewall for private networks; on a Mac, allow incoming connections for Docker Desktop or OrbStack.
3. If it loads but your app fails: the app must use the server's address, not `localhost`. Also set `KEEL_PUBLIC_URL` to that address so email links and Studio's **Connect** panel use it (see [Configuration](/self-hosting/configuration#keel-public-url)).

### Postgres refuses a connection from another machine

Postgres listens on the server only by default (`KEEL_DB_BIND=127.0.0.1`). When it's open to your network, connections from other machines need TLS and a password, and the `postgres` superuser is refused from them:

- **`no pg_hba.conf entry for host …, no encryption`**: the client didn't use TLS. Add `sslmode=require` to the connection string (or turn on SSL in your tool).
- **`pg_hba.conf rejects connection for host …, user "postgres"`**: the superuser can't sign in from other machines. Use another role, an SSH tunnel (`ssh -L 5432:127.0.0.1:5432 you@server`), or set `KEEL_DB_REMOTE_SUPERUSER=on` and run `./keel up`.
- **`keel: no TLS certificate in /var/lib/postgresql/tls` in `keel-db`'s log**: the certificate is missing (an older image, or deleted files), so only Keel's own containers and the server can connect. `./keel up` makes a new one; see [Postgres connections](/self-hosting/security#postgres-connections).

## Features

### Emails don't arrive

Without a mail server, Keel doesn't send email: new accounts are confirmed automatically, and other emails are dropped. Their links and codes aren't logged either (anyone can request them for any address), only a note with the address masked:

```text
2026-10-03T09:20:11.532Z WARN  SMTP is not configured; magiclink email was not sent project=my-app to=a***@example.com
```

Studio shows invite and password reset links on screen instead. While you develop, [Mailpit](/auth/email#testing-with-mailpit) catches every email.

Set up SMTP in `.env` or per project under **Users > Sign-in settings > Mail server** (see [Email setup](/auth/email)). With SMTP set up:

- When the mail server refuses an email, the app gets a `500` error (`unexpected_failure`, "Error sending email"), and a "failed to send … email" line in the `keel-auth` log shows the mail server's error (wrong password, port or TLS setting).
- "Email rate limit exceeded" means more than 6 emails to one address in an hour; Keel also sends at most one email per minute to the same user.
- Check the spam folder, and use a `SMTP_FROM` address your mail provider is allowed to send for.
- Links in emails use `KEEL_PUBLIC_URL`. If they point to `localhost`, fix that setting.

### Realtime doesn't deliver database changes

Check these in order:

1. **The table streams changes.** Turn on **Realtime** for the table in Studio (open the table, then **Policies**), or run `alter publication supabase_realtime add table public.todos;`.
2. **The subscriber may read the row.** Changes respect row level security: a client only receives rows its `select` policies allow. Test the same query with the same user through the REST API.
3. **Deletes on tables with RLS** are only sent with `REPLICA IDENTITY FULL`. Turn on **Send old values on update and delete** for the table, or run `alter table todos replica identity full;`.
4. **Public channels allowed.** If **Private channels only** is on (**Project settings > Realtime**), clients must join with `{ config: { private: true } }`.
5. **WebSockets reach Keel.** Behind nginx or another proxy, the `Upgrade` and `Connection` headers must be passed through (see [nginx](/self-hosting/remote-access#nginx)).

The `keel-realtime` log shows connections and errors. See [Database changes](/realtime/postgres-changes).

### An edge function returns 502, 503 or 504

| Response | Meaning | What to do |
|---|---|---|
| 503 `BOOT_ERROR` "Function failed to start" | The code didn't load: a syntax error, a failing import, or no `Deno.serve`. | Open the function in Studio (**Functions**) and read its logs. The first start downloads imports and may take up to 90 seconds (`KEEL_FUNCTIONS_BOOT_TIMEOUT`). |
| 502 `WORKER_ERROR` "Function stopped before responding" | The process crashed or ran out of memory. | Read the function's logs. Raise `KEEL_FUNCTIONS_MEMORY_MB` if it needs more memory. |
| 504 `WORKER_TIMEOUT` | The request took longer than `KEEL_FUNCTIONS_TIMEOUT` (150 seconds by default). | Make it faster, or raise the limit. |
| 502 "Edge functions are not running" | `keel-functions` is down. | `./keel logs keel-functions`. |
| 401 "Missing authorization header" or "Invalid JWT" | The function requires a JWT. | Call it with the anon key or a user token, or turn off JWT verification for webhooks. |

See [Runtime and limits](/functions/runtime).

### Scheduled jobs don't run, or webhooks don't send

Open **Jobs** in Studio's dock: it lists each job's recent runs and every outgoing request with its response.

- **A run says Failed.** Its message is the SQL error. Jobs run as the project's owner role, not as `postgres`, so a command that works in the SQL editor can fail for lack of rights. A run longer than `KEEL_CRON_TIMEOUT` (300 seconds) is stopped. See [How jobs run](/database/cron#how-jobs-run).
- **A job never runs.** Check that it's active (`select jobname, schedule, active from cron.job;`) and that `keel-studio`, which runs the jobs, is up.
- **Requests stay queued or nothing is sent.** `keel-egress` sends them: check it with `./keel ps` and `./keel logs keel-egress`. An install whose compose file is from 0.2.0 or earlier has no `keel-egress`; [run the installer again](/self-hosting/updating) to get the new compose file.
- **`error_msg` starts with `refused:`.** The URL points at your network, this server or a Keel container, which is closed by default. Open chosen LAN addresses with `KEEL_FUNCTIONS_ALLOW_LAN`; to call your own edge functions, use the project's API URL, which Keel routes inside. See [Which addresses can be reached](/database/webhooks#which-addresses-can-be-reached).

### `create extension vector` or `postgis` fails

"extension is not available" means `keel-db` still runs the plain Postgres image from 0.2.0 or earlier. Run the installer again (or, on ZimaOS, import the new compose file) to switch to `keel-postgres`, which keeps your data as it is. PostGIS also needs the `postgres` superuser: enable it once in Studio's SQL editor. See [Extensions](/database/extensions).

### Full backups fail or don't reach the bucket

Open **Backups** in Studio (the "Last backup" line in the side panel):

- **Full backups are off.** Set `KEEL_BACKUP_PASSPHRASE` (12 characters or more) in `.env` and run `./keel up`.
- **Upload failed.** Hover over the badge for the bucket's error, fix the target, and click **Test connection**. Wrong keys, a wrong region or endpoint, and a bucket that needs **Bucket name in the path** (MinIO and some others) are the usual causes.
- **A backup fails with a message about uploaded files.** The compose file is older than full backups and doesn't let Studio read the storage folder. Run the installer again, or import the new compose file on ZimaOS.

See [Backups and restore](/self-hosting/backups).

### The Cloudflare Tunnel doesn't connect

Studio's **Connect > Internet access** shows the tunnel's state and its log. The usual causes are a token that was copied only in part or refreshed in Cloudflare (paste the whole command again), and a route that points somewhere other than `http://keel-gateway:8000`. The [Cloudflare Tunnel troubleshooting table](/self-hosting/cloudflare-tunnel#troubleshooting) covers each message.

### Large uploads are rejected

Storage answers `413` with "The object exceeded the maximum allowed size". The default limit is 500 MB (`KEEL_STORAGE_MAX_FILE_SIZE=524288000`) with the installer and on ZimaOS, and 50 MB when you build from source. Raise it in your settings and restart, and check the bucket's own file size limit, which can only be lower. A reverse proxy has its own limit too: nginx allows 1 MB unless you set `client_max_body_size`, and Cloudflare's free plan stops at 100 MB per request. For big files, use [resumable uploads](/storage/resumable-uploads).

## The disk is full

Postgres stops writing ("No space left on device"), backups fail and services restart. Check where the space went:

```bash
df -h
docker system df
```

To free space:

- Delete old manual backups in Studio (**Backups**), or lower `KEEL_BACKUP_RETENTION`.
- Remove images left over from earlier updates and builds: `docker image prune` and `docker builder prune`.
- Delete files your apps no longer need from storage buckets.

Realtime uses temporary replication slots, so a stopped or disconnected Keel never makes Postgres hold on to old WAL files.

## Collect logs for a bug report

```bash
docker compose logs --no-color --tail=500 > keel-logs.txt
```

Run it in the install folder (with `sudo` if you installed with it). Add `KEEL_LOG_LEVEL=debug` to your settings and restart for more detail. Remove passwords, keys and email addresses before you share the file.
