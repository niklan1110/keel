# Glossary

The words these docs use, in one place, with a link to the page that explains each one. Most of them mean the same as in Supabase.

## Projects and access

| Term | Meaning |
|---|---|
| **Project** | One app's backend: its own Postgres database, API keys, users, files, edge functions and settings. One Keel server runs many projects side by side. See [Core concepts](/guide/concepts#projects). |
| **API URL** | The address your app passes to `createClient`: `KEEL_PUBLIC_URL` plus the project name, such as `http://192.168.1.20:8000/my-app`. Shown in Studio under **Connect**. |
| **Gateway** | The single entry point for apps, on port 8000 (`keel-gateway`). It checks the API key and sends each request to the right service. See [Architecture](/reference/architecture). |
| **Anon key** | The project's public API key. It goes in browsers and mobile apps; row level security decides what it can do. See [API keys](/guide/api-keys). |
| **Service role key** | The project's secret API key. It bypasses row level security and can manage users, so it belongs only on servers, in scripts and in edge functions. Never ship it in an app. |
| **Signing key** | The secret a project signs its API keys and access tokens with. Rolling the keys makes a new signing key; the old one keeps working for a **grace period**. See [Rolling keys](/guide/api-keys#rolling-keys). |
| **Project owner role** | The Postgres role `<database>_owner` (`my_app_owner` for `my_app`). It owns the project's `public` schema, so migrations, type generation, cron jobs and function deploys use it. It isn't a superuser and can't reach other projects. Studio's **Connect** hands out its connection string. See [Connecting directly](/database/connecting-directly). |
| **Superuser** | The Postgres `postgres` role, with `POSTGRES_PASSWORD` from `.env`. Studio's SQL editor runs as it. It's for server admins only and is refused from other machines unless `KEEL_DB_REMOTE_SUPERUSER=on`. |

## Data and security

| Term | Meaning |
|---|---|
| **Row level security (RLS)** | Postgres rules that decide which rows each request may read and change. Keel turns it on for every new table in `public`. See [Row level security](/database/row-level-security). |
| **Policy** | One RLS rule on a table, written in SQL (`create policy ...`). Without a policy, a table with RLS on can't be read or written with the anon key or a user token. |
| **Access token** | The short-lived JWT a signed-in user's app sends with every request (`Authorization: Bearer ...`). Valid for an hour by default. See [Sessions and tokens](/auth/sessions). |
| **Refresh token** | A long-lived token that gets a new access token when the old one expires. Client libraries use it for you. |
| **aal1, aal2** | Authenticator assurance level, a claim in the access token. `aal2` means the user passed [two-factor authentication](/auth/mfa) in this session. |
| **Defaults** | A saved copy of a project's table rows that **Restore defaults** brings back. See [Defaults](/studio/defaults). |

## Features

| Term | Meaning |
|---|---|
| **Bucket** | A container for files in [Storage](/storage/overview), public or private, with optional size and file type limits. |
| **Signed URL** | A link to a private file that works without a token until it expires. See [Serving files](/storage/serving-files). |
| **Resumable upload** | An upload sent in chunks over the TUS protocol, so it continues after a dropped connection. See [Resumable uploads](/storage/resumable-uploads). |
| **Channel** | A named [Realtime](/realtime/overview) room that clients join for database changes, broadcast and presence. A **private channel** checks policies on `realtime.messages` before a client may join. |
| **Edge function** | A TypeScript or JavaScript program that runs on Deno on your server and answers HTTP requests at `/functions/v1/<name>`. See [Edge functions](/functions/overview). |
| **Function secret** | An environment variable for a project's edge functions, such as a payment provider's API key. See [Secrets](/functions/secrets). |
| **Cold start** | The first request to an edge function that isn't running yet; its process starts first, which takes a moment longer. |
| **Scheduled job (cron job)** | SQL that runs on a schedule, created with `cron.schedule`. See [Scheduled jobs](/database/cron). |
| **Database webhook** | A trigger that sends an HTTP request when a row changes, through `net.http_post` or `supabase_functions.http_request`. The `keel-egress` service sends it. See [Database webhooks](/database/webhooks). |

## Running Keel

| Term | Meaning |
|---|---|
| **Install folder** | The folder the installer put Keel in, such as `/opt/keel`, `~/keel`, `%USERPROFILE%\keel` or `/DATA/AppData/keel`. It holds `.env`, the compose file, the `keel` command and your data. See [Choose a platform](/self-hosting/platforms). |
| **`.env`** | The settings file in the install folder: passwords, `KEEL_PUBLIC_URL` and every other server setting. Readable by its owner only. Keep a copy in your password manager. See [Configuration](/self-hosting/configuration). |
| **`KEEL_PUBLIC_URL`** | The address apps use to reach the gateway, such as `http://192.168.1.20:8000` or `https://api.example.com`. Keel puts it in emails, OAuth callbacks and signed URLs. See [Configuration](/self-hosting/configuration#keel-public-url). |
| **`keel` command** | The script in the install folder that starts, stops, updates, rolls back and restores Keel, and manages keys, functions and Studio accounts. See [keel CLI](/self-hosting/cli). |
| **Studio** | Keel's web dashboard, on port 3000. Every **Studio account** is a full admin of every project; Studio accounts are separate from your apps' users. See [Studio tour](/studio/tour) and [Accounts and sign-in](/studio/accounts). |
| **Project backup** | A nightly or manual `pg_dump` of one project's database, restored from Studio. It doesn't hold uploaded files. See [Backups and restore](/self-hosting/backups#project-backups). |
| **Full backup** | One encrypted file with every project's database, Keel's settings, keys and Studio accounts, and every uploaded file. Made nightly once `KEEL_BACKUP_PASSPHRASE` is set, copied to a **backup target** (an S3-compatible bucket), and restored with `./keel restore`. See [Full backups](/self-hosting/backups#full-backups). |
| **Trusted proxy** | A reverse proxy listed in `KEEL_TRUSTED_PROXIES`, whose `X-Forwarded-For` header Keel believes, so visitor addresses and rate limits are right. See [Visitor addresses and proxies](/self-hosting/remote-access#visitor-addresses-and-proxies). |
| **Tunnel** | A Cloudflare Tunnel that puts Keel on the internet at your own domain without opening a port on your router. See [Cloudflare Tunnel](/self-hosting/cloudflare-tunnel). |
