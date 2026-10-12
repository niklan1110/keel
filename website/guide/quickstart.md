# Quickstart

Install Keel, create a table with a security policy, and read and write it from JavaScript. You need a machine with Docker and about ten minutes. At the end you have a running server, Studio open in your browser, and an app talking to your own API.

::: info What you need
- A computer that can run Docker: a Linux server or PC, a NAS, a Mac, or a Windows 10 or 11 PC. A 64-bit OS with 2 GB of free memory is enough to start; see [Requirements](/self-hosting/requirements).
- Free ports 8000 (API), 3000 (Studio) and 5432 (Postgres).
- [Node.js](https://nodejs.org) on the computer where you try the example app in step 6.
:::

## 1. Get Docker ready

| Your machine | Docker to use | Check |
|---|---|---|
| Linux server or PC | Docker Engine with the Compose plugin ([install guide](https://docs.docker.com/engine/install/)) | `docker compose version` prints v2 or newer |
| macOS | OrbStack, Docker Desktop or Colima ([which one](/self-hosting/macos#pick-a-docker)) | `docker compose version` in Terminal |
| Windows 10 or 11 | Docker Desktop with its default WSL 2 engine ([before you start](/self-hosting/windows#before-you-start)) | Docker Desktop says *Engine running* |
| ZimaOS, CasaOS, Unraid, TrueNAS SCALE, Synology | Already built in (on Synology, install Container Manager) | Open a terminal or SSH session on the NAS |

## 2. Install Keel

Run the installer for your system. It sets Keel up in one folder, writes a `.env` file with random passwords, starts every service and prints your Studio login.

::: code-group

```bash [Linux and NAS]
curl -fsSL @@SITE@@/install.sh | sudo bash
```

```bash [macOS]
# Run as yourself, without sudo.
curl -fsSL @@SITE@@/install.sh | bash
```

```powershell [Windows (PowerShell)]
# No admin rights, WSL terminal or Git Bash needed.
irm @@SITE@@/install.ps1 | iex
```

:::

::: details Download, check, then run
To see what you run first, download the installer and its SHA-256 checksum, check it, read it, then run it:

```bash
curl -fsSLO @@SITE@@/install.sh
curl -fsSLO @@SITE@@/install.sh.sha256
sha256sum -c install.sh.sha256      # macOS: shasum -a 256 -c install.sh.sha256
less install.sh
sudo bash install.sh
```

On Windows, see [Check the installer first](/self-hosting/windows#check-the-installer-first). Each [release on GitHub](https://github.com/@@REPO@@/releases) has its own installer, which installs exactly that version, with the same checksum file and a build attestation (`gh attestation verify install.sh --repo @@REPO@@`). Its address names the version: `https://github.com/@@REPO@@/releases/download/v<version>/install.sh`.
:::

The installer picks the right folder for your system: `/opt/keel` on Linux (`~/keel` without `sudo`), `~/keel` on a Mac, `%USERPROFILE%keel` on Windows, and the app data folder on a NAS (see [Choose a platform](/self-hosting/platforms)). On a NAS it opens Studio to your network; on a cloud server, a Mac or Windows it keeps Studio on the machine itself; elsewhere it asks. When it finishes, it prints something like:

```text
Keel is running.

  Studio (dashboard):  http://192.168.1.20:3000
  Sign in:             admin / <generated password>
  API for your apps:   http://192.168.1.20:8000/my-app
  Settings:            /opt/keel/.env   (passwords; keep a copy somewhere safe)
  Data:                /opt/keel/{db,db-tls,storage,backups,functions,tunnel}
```

The first run downloads the images, which takes a few minutes. Keep a copy of `.env` in your password manager: it holds the passwords you need to restore a backup.

The installer uses this machine's IP address in the API URL, so phones and laptops on your network can reach Keel. That address is stored as `KEEL_PUBLIC_URL` and appears in emails and links (see [Configuration](/self-hosting/configuration)). To use another address, such as a hostname, pass `--host`: `curl -fsSL @@SITE@@/install.sh | sudo bash -s -- --host myserver.local`. [Linux (Docker Compose)](/self-hosting/docker#options) lists every option, and each platform guide covers its details: [Windows](/self-hosting/windows), [macOS](/self-hosting/macos), [ZimaOS](/self-hosting/zimaos), [Unraid](/self-hosting/unraid), [TrueNAS SCALE](/self-hosting/truenas), [Synology](/self-hosting/synology).

Check that all services are up, in the install folder:

::: code-group

```bash [Linux, macOS and NAS]
cd /opt/keel          # or ~/keel, or your NAS folder
sudo ./keel ps        # without sudo if you installed without it
```

```powershell [Windows]
cd $HOMEkeel
.keel ps
```

:::

After a minute or two, every service should be `running` or `healthy`. If one keeps restarting, see [Troubleshooting](/self-hosting/troubleshooting).

## 3. Open Studio

Open the Studio address the installer printed (on the server itself, **http://localhost:3000** always works; from other devices only if Studio is open to your network) and sign in as `admin` with the password it printed. The password is also in the install folder's `.env` file as `KEEL_DASHBOARD_PASSWORD`.

A first project called **my-app** already exists. Studio shows the project's tables on a canvas, with the stack's services and backups in the side panel and the tools (SQL, Users, Storage, Functions, Jobs, Logs) in the dock at the bottom.

## 4. Create a table

Open the **SQL** editor in the dock at the bottom and run:

```sql
create table todos (
  id bigint generated always as identity primary key,
  task text not null,
  done boolean not null default false,
  user_id uuid references auth.users default auth.uid(),
  created_at timestamptz not null default now()
);

-- Signed-in users see and change only their own todos.
create policy "own todos" on todos for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Keel turns on [row level security](/database/row-level-security) for every new table, so the table is private until a policy allows access. The policy above lets each signed-in user work with their own rows.

## 5. Get your API URL and key

Click **Connect** in Studio's header. Copy:

- **API URL**: your server's address plus the project name, such as `http://192.168.1.20:8000/my-app`
- **anon key**: a long token starting with `eyJ`. It's safe to put in browser and mobile apps.

## 6. Use it from your app

Install the Supabase JavaScript client (Keel speaks the same APIs):

```bash
npm install @supabase/supabase-js
```

```js
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')

// Create an account. Without an email server, new accounts are confirmed right away.
await keel.auth.signUp({ email: 'ada@example.com', password: 'a-long-password' })

// Add and read todos. Row level security limits this to the signed-in user.
await keel.from('todos').insert({ task: 'Try Keel' })
const { data, error } = await keel.from('todos').select('*').order('created_at')
console.log(data)
```

Replace the URL with your API URL (`localhost` works only when the code runs on the Keel server) and `YOUR_ANON_KEY` with the anon key. Run it with `node` (save it as `app.mjs`) or put it in your web app. Back in Studio, the new user shows up under **Users**, and clicking the `todos` table on the canvas shows the new row.

You can do the same without a client library, from any language:

```bash
curl 'http://localhost:8000/my-app/rest/v1/todos?select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

## 7. Before you rely on it

A few minutes now saves a bad day later:

1. **Secure Studio.** In Studio, open **Account and security** from the project switcher, change the generated password and turn on two-factor authentication. See [Accounts and sign-in](/studio/accounts).
2. **Turn on full backups.** Set `KEEL_BACKUP_PASSPHRASE` in `.env`, run `./keel up` (`.\keel up` on Windows), and add an S3-compatible bucket in Studio's **Backups**. Keel then keeps an encrypted copy of everything off the machine. See [Backups and restore](/self-hosting/backups).
3. **Read the security checklist** before you open Keel to the internet: [Security](/self-hosting/security).

## Next steps

<div class="cards">
  <a class="card" href="./concepts"><strong>Core concepts</strong><span>Projects, the two API keys, user tokens and row level security.</span></a>
  <a class="card" href="./connecting"><strong>Connect your app</strong><span>Client libraries for JavaScript, Flutter, Swift, Kotlin and Python.</span></a>
  <a class="card" href="../database/querying"><strong>Querying</strong><span>Filters, joins, pagination, inserts and upserts.</span></a>
  <a class="card" href="../auth/overview"><strong>Auth</strong><span>Every way your users can sign in.</span></a>
  <a class="card" href="../self-hosting/remote-access"><strong>Internet access and HTTPS</strong><span>Use Keel away from home and from HTTPS sites.</span></a>
  <a class="card" href="./coming-from-supabase"><strong>Coming from Supabase</strong><span>Move an existing project and its users over.</span></a>
</div>
