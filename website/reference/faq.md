# FAQ

Short answers to the questions people ask most about Keel, each with a link to the page that has the details. For error messages and things that don't work, see [Troubleshooting](/self-hosting/troubleshooting).

## About Keel

### What is Keel, in one sentence?

A backend you run on your own machine with Docker: Postgres with an instant REST API, auth, file storage, realtime and edge functions, plus a dashboard (Studio), all speaking the Supabase APIs. See [What is Keel?](/guide/introduction).

### Do I need a Supabase account?

No. Keel is independent software that uses the open-source Supabase client libraries. It never contacts Supabase unless you run the [importer](/self-hosting/migrate-from-supabase) to copy a project over.

### What does it cost?

Nothing. Keel is open source under the MIT license, and it has no usage quotas or bills. Your limits are your hardware's; see [Limits](/reference/limits).

### Is Keel a drop-in replacement for Supabase?

For most apps, yes: change the API URL and the anon key. Some Supabase features aren't in Keel yet, such as GraphQL, Vault, the S3 protocol and SAML SSO. See [Coming from Supabase](/guide/coming-from-supabase) and the [compatibility table](/reference/compatibility).

### Which client libraries can I use?

`@supabase/supabase-js` v2, which Keel is tested with, and the Supabase clients for Flutter, Swift, Kotlin and Python, which call the same endpoints. Any HTTP client works too. See [Connecting your app](/guide/connecting).

### Can I run several apps on one server?

Yes. Each app gets its own [project](/guide/concepts#projects), with its own database, keys, users and files. Create one with **New project** in Studio's project switcher.

### Is Keel ready for my business?

Keel runs on one server: there's no automatic scaling, failover or global network. It suits personal projects, homelabs, internal tools and small teams' apps, as long as you set up [full backups](/self-hosting/backups#full-backups) to a bucket off the machine and work through the [security checklist](/self-hosting/security).

## Installing

### What hardware do I need?

A 64-bit machine that can run Docker, with 1 to 2 GB of memory free for Keel (4 GB or more in the machine is comfortable). A Raspberry Pi 4 or 5, a NAS, a mini PC or a cloud server all work. See [Requirements](/self-hosting/requirements).

### Does it run on Windows without WSL?

Yes. The [Windows installer](/self-hosting/windows) is a PowerShell script for Docker Desktop; you don't need a WSL terminal, Git Bash or admin rights. Docker Desktop itself uses WSL 2 under the hood, which its installer sets up.

### Which NAS systems are supported?

ZimaOS, CasaOS, Unraid, TrueNAS SCALE and Synology DSM 7.2 or newer, with the installer or from the NAS's own app screen. See [Choose a platform](/self-hosting/platforms).

### Where is my data?

In the install folder, such as `/opt/keel`: the database in `db/`, uploaded files in `storage/`, backups in `backups/`, and every setting and password in `.env`. On Windows, the database is in a Docker volume. See [Where your data lives](/self-hosting/docker#where-your-data-lives).

## Running Keel

### How do I update?

Run `./keel update` in the install folder (or the installer again). It backs up every database first, and `./keel rollback` goes back if something is wrong. See [Updating](/self-hosting/updating).

### How do I back up everything and move to a new machine?

Set `KEEL_BACKUP_PASSPHRASE` in `.env` and add an S3-compatible bucket in Studio's **Backups**. Keel then writes one encrypted file each night with every database, setting and uploaded file. On the new machine, install Keel and run `./keel restore`. See [Disaster recovery](/self-hosting/backups#disaster-recovery).

### How do I reach Keel from outside my home?

Privately over Tailscale, or publicly through a Cloudflare Tunnel or your own reverse proxy with HTTPS. See [Internet access and HTTPS](/self-hosting/remote-access).

### Can other people use Studio?

Yes. Add Studio accounts under **Account and security**. Every Studio account is a full admin of every project, so give accounts only to people you'd give the server's root password. See [Accounts and sign-in](/studio/accounts).

### I forgot my Studio password. How do I get back in?

Change `KEEL_DASHBOARD_PASSWORD` in `.env` and run `./keel up`: Studio resets the owner's password to it. For other accounts, run `./keel studio-user reset-password <name>`. See [Locked out](/studio/accounts#locked-out).

### Does Keel send data anywhere?

No usage data. It downloads its images and your edge functions' imports, and Studio checks for a newer release once a day at most (`KEEL_UPDATE_CHECK=off` turns that off). Everything else, such as emails, webhooks and backup uploads, happens only when you set it up. See [Network](/self-hosting/requirements#network).

## Building apps

### Why can't my app read a table I just created?

Keel turns on row level security for every new table, so it's private until you add a policy. See [Row level security](/database/row-level-security).

### Why don't my users get emails?

Keel sends email only after you add an SMTP server, per project or for the whole server. Until then it sends none, and new accounts are confirmed right away (on a public server, new projects start with sign-ups switched off). See [Email setup](/auth/email).

### Can I connect with psql, an ORM or a migration tool?

Yes. Use the connection string from Studio's **Connect**, which logs in as the project's owner role. From another computer, open Postgres to your network first. See [Connecting directly](/database/connecting-directly).

### Can I run code on a schedule or when a row changes?

Yes: [scheduled jobs](/database/cron) with `cron.schedule`, and [database webhooks](/database/webhooks) that call an edge function or any URL. Or use an [edge function](/functions/overview) for code that needs secrets or npm packages.

### Can I use vector search?

Yes. pgvector is installed: `create extension vector with schema extensions`, then store embeddings and search them through a database function. See [Extensions](/database/extensions).
