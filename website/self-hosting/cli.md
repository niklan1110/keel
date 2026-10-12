# keel CLI

`keel` is a small bash script that comes with Keel. The [installer](/self-hosting/docker) puts it in the install folder next to the compose file (`/opt/keel/keel`, `~/keel/keel` or `/DATA/AppData/keel/keel`), and a copy of the source code has it at the top. It wraps `docker compose` and runs Keel's one-off commands (deploying functions, setting secrets, importing from Supabase) in a temporary container.

```bash
cd /opt/keel                                 # your install folder
./keel ps                                    # is everything running?
./keel update                                # back up, move to the newest release, restart
./keel functions deploy --project my-app     # deploy ./supabase/functions
```

On Windows, the [Windows installer](/self-hosting/windows) puts a PowerShell version of the same command in the install folder: run it as `.\keel` (through `keel.cmd`, so the PowerShell execution policy doesn't matter), with the same commands and options as below, except `init`, which is for a copy of the source code, and `restore`, which only the bash `keel` has so far (see [Disaster recovery](/self-hosting/backups#disaster-recovery)).

Run `./keel` with no arguments for a summary. If you installed with `sudo`, the settings file (`.env`) belongs to root, so run the script with `sudo` too: `sudo ./keel ps`. Commands that act on a project take `--project NAME` and default to `KEEL_DEFAULT_PROJECT` (`my-app`). Commands that read files, such as `functions deploy` and `secrets set --env-file`, resolve paths from the folder you run the script in, so you can call it by its path from your app's repository: `~/keel/keel functions deploy`.

## Commands

| Command | What it does |
|---|---|
| [`init`](#init) | Create `.env` with random secrets (source checkout only) |
| [`up`](#up) | Pull or build the images and start the stack |
| [`down`](#down) | Stop and remove the containers (data is kept) |
| [`ps`](#ps) | Show container status |
| [`logs`](#logs) | Follow logs |
| [`psql`](#psql) | Open `psql` in a project's database |
| [`functions`](#functions) | Deploy, list and delete edge functions |
| [`secrets`](#secrets) | Manage edge function secrets |
| [`import-supabase`](#import-supabase) | Copy a Supabase project into Keel |
| [`studio-user`](#studio-user) | Manage Studio accounts: recovery after a lost password or phone |
| [`keys`](#keys) | Show or roll a project's API keys |
| [`update`](#update) | Back up every database, then move to the newest release and restart |
| [`rollback`](#rollback) | Go back to the version before the last update |
| [`restore`](#restore) | Put back a full backup: every database and uploaded file |
| [`version`](#version) | Show the version running and the previous one |

## init

```bash
./keel init [--url URL] [--project NAME] [--lan] [--lan-db] [--force]
```

Only for a copy of the source code; the installer writes `.env` itself. Copies `.env.example` to `.env`, fills in random values for `POSTGRES_PASSWORD`, `KEEL_SERVICE_PASSWORD`, `KEEL_SECRET`, `KEEL_DASHBOARD_PASSWORD`, `KEEL_FUNCTIONS_TOKEN`, `IMGPROXY_KEY` and `IMGPROXY_SALT`, sets `KEEL_HOST_LABEL` to the hostname, makes the file readable only by you, and prints the Studio login. The file is written in one go at the end, so a failed `init` never leaves a half-written `.env` behind.

Studio and Postgres listen on this machine only, unless you pass `--lan` or `--lan-db`.

| Option | Description |
|---|---|
| `--url URL` | `KEEL_PUBLIC_URL`, the address apps use to reach the API. Default: `http://<this machine's IP>:8000`, or `http://localhost:8000` if the IP can't be found. On a Mac the IP comes from `en0`, then `en1`; in Git Bash and WSL it's the Windows PC's address on your network. |
| `--project NAME` | `KEEL_DEFAULT_PROJECT`, the first project's name. Default `my-app`. |
| `--lan` | Open Studio to your network (`KEEL_STUDIO_BIND=0.0.0.0`). |
| `--lan-db` | Open Postgres to your network (`KEEL_DB_BIND=0.0.0.0`). Connections from other machines then need TLS, and the `postgres` superuser needs `KEEL_DB_REMOTE_SUPERUSER=on`; see [Security](/self-hosting/security#postgres-connections). |
| `--force` | Overwrite an existing `.env`. On an existing install this locks Keel out of its own database, because the database keeps the old password. |

```text
Wrote .env

  API gateway:  http://192.168.1.20:8000
  Studio:       http://localhost:3000
  Studio login: admin / <generated password>

Next: ./keel up
```

## up

```bash
./keel up [service ...]
```

Pulls the `keel`, `keel-functions` and `keel-postgres` images for your tag, then runs `docker compose up -d`. In a source checkout it builds the images instead, unless `KEEL_IMAGE`, `KEEL_FUNCTIONS_IMAGE` and `KEEL_DB_IMAGE` are set in `.env`. Extra arguments go to `docker compose up -d`. Run it after every change to `.env`. Needs `.env` (in a source checkout, run `init` first).

## down

```bash
./keel down [options]
```

Runs `docker compose down`: stops and removes the containers and networks. Your data stays in the install folder (or, in a source checkout, in Docker volumes). Options go to Compose. In a source checkout, `./keel down -v` **also deletes the volumes**, which means every database, file and backup.

## ps

```bash
./keel ps
```

Runs `docker compose ps`: each container with its state and health.

## logs

```bash
./keel logs [service ...]
```

Follows the last 200 lines and new output of every service, or only the ones you name. Press Ctrl+C to stop.

```bash
./keel logs keel-auth keel-gateway
```

## psql

```bash
./keel psql [project]          # or: ./keel psql --project my-app
```

Opens `psql` as the `postgres` superuser inside the `keel-db` container, in the project's database (`my-app` → `my_app`). Without a project it uses `KEEL_DEFAULT_PROJECT`; `./keel psql postgres` opens the `postgres` database and `./keel psql keel` Keel's own control database. You can pipe SQL into it:

```bash
./keel psql my-app < schema.sql
```

## functions

`./keel fn` is a shorter alias.

### functions deploy

```bash
./keel functions deploy [name ...] [--project NAME] [--dir PATH] [--no-verify-jwt]
```

Deploys edge functions from `./supabase/functions` (or `./functions`) in the current folder, in the same layout as the Supabase CLI. Without names, every function folder is deployed.

| Option | Description |
|---|---|
| `name ...` | Deploy only these functions. |
| `--project NAME` | Target project (also `-p NAME` or `--project=NAME`). |
| `--dir PATH` | Read functions from another folder. |
| `--no-verify-jwt` | Let these functions be called without a JWT (for webhooks). |

```text
$ ~/keel/keel functions deploy --project my-app
Deployed hello v1 (2 files, 0.4 KB)
  http://192.168.1.20:8000/my-app/functions/v1/hello
Deployed stripe-webhook v3 (2 files, 1.9 KB, JWT check off)
  http://192.168.1.20:8000/my-app/functions/v1/stripe-webhook
```

- Each folder whose name doesn't start with `_` or `.` is a function, and needs an `index.ts` (or `index.js`, `.tsx`, `.jsx`, `.mjs`, `.mts`). Names start with a letter and use letters, digits, `-` and `_` (up to 63 characters).
- Folders starting with `_` (such as `_shared`) and a top-level `import_map.json` are included with every function.
- `verify_jwt = false` under `[functions.<name>]` in `supabase/config.toml` is respected. `--no-verify-jwt` turns the check off for every function in the command.
- Dotfiles and `node_modules`, `.git`, `.vscode`, `tests` and `__tests__` folders are skipped, as are binary files and files over 5 MB (listed as "Skipped binary or oversized files"). A function can have at most 500 files and 20 MB of source.

Every function is checked before any is deployed: if one is invalid (for example a folder without an `index.ts`), the command stops and nothing is deployed. Each deploy creates a new version. Running instances finish their requests and restart with the new code. See [Deploying](/functions/deploying).

### functions list

```bash
./keel functions list [--project NAME]
```

```text
hello                        v1     jwt  2026-10-03T09:30:12.000Z
stripe-webhook               v3     public  2026-10-03T09:30:12.000Z
```

`jwt` means requests need a valid JWT; `public` means the check is off.

### functions delete

```bash
./keel functions delete name [name ...] [--project NAME]
```

Deletes the functions. Prints `Deleted hello`, or `No function named hello` if it doesn't exist. A project that doesn't exist stops the command with an error.

## secrets

Environment variables for a project's edge functions, read with `Deno.env.get()`. See [Secrets](/functions/secrets).

```bash
./keel secrets list [--project NAME]
./keel secrets set NAME=value [NAME=value ...] [--env-file FILE] [--project NAME]
./keel secrets unset NAME [NAME ...] [--project NAME]
```

```text
$ ./keel secrets set STRIPE_KEY=sk_live_123 STRIPE_WEBHOOK_SECRET=whsec_456 --project my-app
Set STRIPE_KEY, STRIPE_WEBHOOK_SECRET for my-app. Running functions restart with the new values.
```

- `list` shows names and when they were last changed, never the values.
- `--env-file FILE` reads `NAME=value` lines from a file such as `supabase/.env`. Blank lines and `#` comments are skipped, and an `export ` prefix and surrounding quotes are removed.
- Values can be up to 64 KB.
- Names use letters, digits and underscores and don't start with a digit. Names Keel sets itself can't be used: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PATH`, `HOME`, `TMPDIR`, anything starting with `KEEL_`, `DENO_`, `NODE_`, `LD_` or `SSL_CERT_`, and anything ending in `_PROXY`.

## import-supabase

```bash
./keel import-supabase --db-url URL [--url URL --service-key KEY] [--project NAME]
                       [--no-schema] [--no-auth] [--no-storage]
```

Copies a Supabase project's schema, data, users, policies and files into an existing Keel project. `--url` and `--service-key` are needed to copy files; `--no-schema`, `--no-auth` and `--no-storage` skip parts of the import. See [Migrate from Supabase](/self-hosting/migrate-from-supabase).

## studio-user

```bash
./keel studio-user list
./keel studio-user add <name> [--password P]
./keel studio-user reset-password <name> [--password P]
./keel studio-user reset-2fa <name>
./keel studio-user remove <name>
```

Manages [Studio accounts](/studio/accounts) from the server, for when nobody can sign in. `reset-password` and `add` print a generated password when you leave out `--password`. Resetting a password or two-factor ends that account's sessions. The owner account (`KEEL_DASHBOARD_USERNAME`) can't be removed, and changing `KEEL_DASHBOARD_PASSWORD` in `.env` resets its password again on Studio's next start.

On a ZimaOS App Store install, which has no `keel` script: `docker compose run --rm --no-deps -T keel-migrate studio-user reset-2fa admin`, run in the compose file's folder.

## keys

```bash
./keel keys list <project>
./keel keys roll <project> [--grace HOURS]
./keel keys roll <project> --emergency --yes
./keel keys revoke-old <project>
```

Rolls a project's [API keys](/guide/api-keys). `roll` makes a new signing key and prints the new anon and service role keys; the old keys keep working for `--grace` hours (24 by default, 1 to 720). `revoke-old` stops them before that. `--emergency` stops every old key at once and signs out every user of the project. `list` shows the keys and the latest rolls with who made them (`cli` or the Studio account).

On a ZimaOS App Store install: `docker compose run --rm --no-deps -T keel-migrate keys roll my-app`.

## update

```bash
./keel update [--version 0.2.0] [--no-backup] [--yes]
```

Moves to the newest release (or the version you name), in this order: downloads the new images (if that fails, nothing changes), dumps every database (each project and Keel's own) into `backups/pre-update/<date-time>/`, writes the new version to `KEEL_VERSION` and the old one to `KEEL_PREVIOUS_VERSION` in `.env`, restarts Keel and waits until it answers. It refuses to "update" to an older version; use [`rollback`](#rollback) for that. `--no-backup` skips the dumps, and `--yes` answers its questions for you.

In a source checkout, it backs up the databases, runs `git pull --ff-only` (in a git clone) and rebuilds. To also update the `keel` script and the compose file, run the installer again. See [Updating](/self-hosting/updating).

## rollback

```bash
./keel rollback [--restore] [--no-restore] [--yes]
```

Goes back to `KEEL_PREVIOUS_VERSION`. If the newer version upgraded the database schema since the backup taken before the update, the older version can't run on it, so `rollback` asks whether to restore that backup (every database; changes made since then are lost). `--restore` restores it without the question being needed, `--no-restore` never restores, and `--yes` answers yes. The installer does the same with `--rollback` (and `--rollback --restore`).

## restore

```bash
./keel restore --list
./keel restore <file or name> [--verify] [--yes]
```

`--list` shows the [full backups](/self-hosting/backups#full-backups) in `backups/full` and in the backup target. `restore` takes a full backup file on this machine, or a backup's name (`keel-20261003-030000.tar.age`), which it looks for in `backups/full` and then downloads from the target. It decrypts and checks the whole file first, and stops there with `--verify` or when the passphrase is wrong. Then, after you confirm (`--yes` skips the question), it stops Keel, replaces every database and uploaded file with the backup's, and starts Keel again. The passphrase comes from `KEEL_BACKUP_PASSPHRASE` in `.env`, or is asked for. See [Disaster recovery](/self-hosting/backups#disaster-recovery).

## version

```bash
./keel version
```

Prints the running version and the one `rollback` would go back to.

## Commands in the Keel image

The `./keel` script runs `functions`, `secrets`, `import-supabase`, `studio-user`, `keys` and `restore` as one-off containers of the `keel` image (`docker compose run --rm --no-deps -T keel-migrate ...`), so `keel-db` must be running. The image also has a command that needs no database:

```bash
docker run --rm @@IMAGES@@/keel:latest generate-env
```

```text
POSTGRES_PASSWORD=5f0c…
KEEL_SECRET=9b2e…
KEEL_DASHBOARD_PASSWORD=<generated>
IMGPROXY_KEY=1d7a…
IMGPROXY_SALT=c03f…
```

It prints a fresh set of secrets, for a ZimaOS App Store compose file or a `.env` you write by hand. With a local build, use `keel:local` as the image.

### Without the keel script

A ZimaOS App Store install doesn't include the `keel` script, but the same commands work through Compose in the folder that holds its compose file (see [ZimaOS](/self-hosting/zimaos#option-b-app-store-custom-app) for how to find it):

```bash
cd /path/to/the/compose/folder

# List functions and set a secret
docker compose run --rm --no-deps -T keel-migrate fn list --project my-app
docker compose run --rm --no-deps -T keel-migrate secrets set STRIPE_KEY=sk_live_123 --project my-app

# Deploy functions from a folder on the NAS
docker compose run --rm --no-deps -T \
  -v /DATA/code/my-app/supabase/functions:/src/functions:ro \
  keel-migrate fn deploy --project my-app

# psql into a project's database
docker compose exec keel-db psql -U postgres -d my_app
```

Studio's **Functions** tool can create, edit and deploy functions too, without a terminal.

### From another computer

The image's commands can also run away from the server, against its published Postgres port. Set `KEEL_DB_URL` to a project's connection string (from Studio > **Connect**, with the password filled in) instead of the separate database settings. `fn` and `secrets` work with the project's owner role, the connection string Studio shows; the other commands need the `postgres` superuser, which from another machine also needs `KEEL_DB_REMOTE_SUPERUSER=on`. From another machine the server needs `KEEL_DB_BIND=0.0.0.0` and the URL needs `sslmode=require` (TLS), or reach Postgres through an SSH tunnel (`ssh -L 5432:127.0.0.1:5432 you@server`, then use `localhost` in the URL):

```bash
export KEEL_DB_URL='postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require'

docker run --rm -e KEEL_DB_URL -v "$PWD/supabase/functions:/src/functions:ro" \
  @@IMAGES@@/keel:latest fn deploy --project my-app
docker run --rm -e KEEL_DB_URL @@IMAGES@@/keel:latest secrets set STRIPE_KEY=sk_live_123 --project my-app
```

Only the host, port, user, password and `sslmode` of the URL are used (`require`, as in Studio's string, encrypts without checking the self-signed certificate); `--project` picks the project. A wrong password stops right away with `password authentication failed` and a hint to check `KEEL_DB_URL`. This is how coding agents deploy functions, see [Build with AI agents](/guide/ai-agents#giving-the-agent-server-access).
