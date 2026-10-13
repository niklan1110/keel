# Deploying

Keep your functions in your app's repository, in the same layout the Supabase CLI uses, and deploy them with `./keel functions deploy`. You can also create and edit functions in Studio, or [deploy from another computer](#deploy-from-another-computer-or-ci) with the Keel image.

```bash
./keel functions deploy --project my-app          # every function in ./supabase/functions
./keel functions deploy hello --project my-app    # only this one
```

## Folder layout

```text
supabase/
├── config.toml              # optional: verify_jwt per function
└── functions/
    ├── import_map.json      # optional: import map for every function
    ├── _shared/             # shared code, copied into every function
    │   └── cors.ts
    ├── hello/
    │   └── index.ts
    └── stripe-webhook/
        ├── deno.json        # optional: this function's imports and config
        └── index.ts
```

- **Each folder is a function.** Every top-level folder whose name doesn't start with `_` or `.` is deployed as a function, and the folder name is the function name. Names start with a letter, use letters, digits, `-` and `_`, and are at most 63 characters long.
- **The entrypoint** is `index.ts` in the function's folder. `index.js`, `index.tsx`, `index.jsx`, `index.mjs` and `index.mts` work too (Keel uses the first one it finds, in that order).
- **Shared code** goes in folders starting with `_`. They're bundled with every function, so imports such as `import { corsHeaders } from '../_shared/cors.ts'` work exactly as they do locally.
- A top-level `functions/` folder works instead of `supabase/functions/`. Keel then reads `config.toml` from the folder that contains `functions/`.

When you deploy, Keel leaves out:

- files and folders whose names start with `.` (such as `.env` and `.npmrc`)
- folders named `node_modules`, `.git`, `.vscode`, `tests` and `__tests__`
- binary files and files larger than 5 MB

The command lists anything it skipped: `Skipped binary or oversized files: ...`. Functions can only contain text files, so put images and other binary assets in [Storage](/storage/overview) and fetch them at runtime.

::: warning Every folder must be a function
A top-level folder without an `index.ts` (for example `utils/`) makes the deploy fail with `Entrypoint utils/index.ts is not among the files`. Keel checks every function before deploying any, so nothing is deployed in that case. Rename such folders to start with `_`, like `_utils/`.
:::

## Deploy with the CLI

```bash
./keel functions deploy [name ...] [--project NAME] [--dir PATH] [--no-verify-jwt]
```

| Option | Description |
|---|---|
| `name ...` | Functions to deploy. Without names, every function folder is deployed. |
| `--project NAME`, `-p NAME` | Project to deploy to. Defaults to `KEEL_DEFAULT_PROJECT` (`my-app`). |
| `--dir PATH` | Your functions folder. Without it, the command looks for `supabase/functions`, then `functions`, in the current directory. |
| `--no-verify-jwt` | Let anyone call the deployed functions, without a JWT. See [below](#turning-off-jwt-verification). |

The `keel` script can live anywhere: it remembers the folder you ran it from. So with Keel installed in `~/keel` (the installer's folder when you run it without `sudo`) and your app in `~/code/my-app`:

```bash
cd ~/code/my-app
~/keel/keel functions deploy --project my-app
```

```text
Deployed hello v4 (2 files, 1.3 KB)
  http://localhost:8000/my-app/functions/v1/hello
Deployed stripe-webhook v1 (2 files, 2.8 KB, JWT check off)
  http://localhost:8000/my-app/functions/v1/stripe-webhook
```

The command runs a short-lived container from Keel's image through Docker Compose and writes to the running database, so run it on the server where Keel runs, with the stack up. Keel picks up the new version within moments of the command finishing.

## Turning off JWT verification

By default, a function only runs for requests that carry a valid JWT for the project: the anon key, the service role key or a signed-in user's token. Webhooks from other services don't have one, so turn the check off for those functions (and [verify the sender yourself](/functions/auth#webhooks-from-other-services)).

Put the setting in `supabase/config.toml`, like on Supabase:

```toml
[functions.stripe-webhook]
verify_jwt = false
```

Or pass `--no-verify-jwt`, which applies to every function in that deploy and wins over `config.toml`. Without either, `verify_jwt` is on.

::: warning Each CLI deploy sets verify_jwt again
`./keel functions deploy` always writes the setting. If you turned the check off in Studio and later deploy without `--no-verify-jwt` or a `config.toml` entry, it's turned back on. Keep the setting in `config.toml` so every deploy agrees.
:::

Keel only reads `verify_jwt` from `config.toml`. Other function keys that the Supabase CLI understands, such as `entrypoint`, `import_map` and `static_files`, are ignored.

## Imports and dependencies

Functions import packages the Deno way, with no `npm install` step:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17'
import { encodeHex } from 'jsr:@std/encoding@1/hex'
import dayjs from 'https://esm.sh/dayjs@1.11.13'
```

To use short names, add an import map. Keel uses the first of these it finds:

1. `deno.json` or `deno.jsonc` in the function's folder, as the function's Deno config (its `imports` act as the import map)
2. `import_map.json` in the function's folder
3. `import_map.json` at the top of the functions folder, shared by every function

```jsonc
// supabase/functions/stripe-webhook/deno.json
{
  "imports": {
    "stripe": "npm:stripe@17",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2"
  }
}
```

A `deno.json` at the top of the functions folder is not deployed; put one in each function's folder instead. Keel doesn't run `npm install` and doesn't deploy `node_modules`: dependencies come from the specifiers in your code and import map. Lockfiles (`deno.lock`) are ignored, so pin versions in your specifiers (`npm:stripe@17`, not `npm:stripe`).

**Downloads and caching.** Packages are downloaded the first time a function starts and kept in a cache in Keel's functions data (the `functions/cache` folder of your install folder, `/var/lib/keel/functions/cache` inside the container). The cache is shared by all functions and projects and survives restarts and redeploys, so later starts don't download again. The first start therefore needs internet access from your server, and it has 90 seconds to finish, downloads included (`KEEL_FUNCTIONS_BOOT_TIMEOUT` in `.env` changes that). After that, functions keep working offline as long as their imports don't change.

Deno doesn't type-check code when it runs it, so a type error won't stop a deploy. Run `deno check supabase/functions/hello/index.ts` locally to catch them.

## Versions

Every deploy creates a new version of the function (`v1`, `v2`, ...), even if the code didn't change. Keel stores only the latest version: to roll back, deploy the older code again from your repository.

When a new version arrives, the running process finishes the requests it's handling (for up to the [request time limit](/functions/runtime#limits)) and stops. The next request starts the new version.

::: tip Keep your functions in git
Function code and secrets are stored in Keel's own control database, not in your project's database, so [backups](/self-hosting/backups) of a project don't include them. Your repository is the source of truth.
:::

## Size limits

| Limit | Value |
|---|---|
| Files per function | 500 |
| Total source per function | 20 MB, including the shared `_` folders and the import map |
| Single file (CLI and Studio folder upload) | 5 MB; larger files are skipped |
| File types | Text only |
| File paths | Letters, digits, spaces and `. _ @ + -` in each part; at most 300 characters |

## List and delete functions

```bash
./keel functions list --project my-app
```

```text
hello                        v4     jwt  2026-10-01T09:12:44.120Z
stripe-webhook               v1     public  2026-10-02T17:03:10.554Z
```

Each line shows the name, the current version, `jwt` or `public` (JWT check off) and when it last changed.

```bash
./keel functions delete hello --project my-app
```

Within moments, a deleted function starts answering `404` and its process stops. The project's secrets stay, since they belong to the project, not to one function.

## Deploy from Studio

Open **Functions** in Studio's dock:

- **New function** creates a function from a single `index.ts` that you type or paste. Set **Require a valid JWT** before you click **Deploy**.
- **Upload folder** (on the new function screen) deploys a folder from your computer. Pick the function's own folder, the one with `index.ts` at its top level. The function is named after the **Name** field, or after the folder when the field is empty. Only that folder is uploaded, so imports from `../_shared` won't resolve; deploy functions that use shared folders with the CLI.
- The **Code** tab of a function edits any of its files, including shared ones deployed by the CLI. Click **Deploy changes** to publish a new version. You can't add new files here.
- The **Settings** tab has the **Require a valid JWT** switch, which takes effect immediately without restarting the function, and **Delete function**.

## Deploy from another computer or CI

`./keel functions deploy` runs on the Keel server. From your laptop or a CI job, you have three options.

**Run the Keel image with `KEEL_DB_URL` (recommended).** The Keel image contains the same CLI. Give it the project's Postgres connection string (Studio > **Connect**; the copy button includes the password) and mount your functions folder:

```bash
export KEEL_DB_URL='postgresql://my_app_owner:OWNER_PASSWORD@192.168.1.20:5432/my_app?sslmode=require'

docker run --rm -e KEEL_DB_URL -v "$PWD/supabase/functions:/src/functions:ro" \
  @@IMAGES@@/keel:latest fn deploy --project my-app

# With a supabase/config.toml, mount it too so verify_jwt settings apply:
#   -v "$PWD/supabase/config.toml:/src/config.toml:ro"
```

`fn list`, `fn delete <name>`, `secrets list`, `secrets set NAME=value` and `secrets unset NAME` work the same way. This needs Docker where you run it and the Postgres port (5432) reachable from there. `KEEL_DB_URL` connects as the project's owner role, which can deploy only this project's functions but can change all of its data, so keep it in your CI's secret store. If Keel runs on the same computer, use `host.docker.internal` (macOS, Windows) or `--network host` (Linux) instead of `localhost`. Coding agents can deploy the same way; see [Build with AI agents](/guide/ai-agents#giving-the-agent-server-access).

**Run the CLI over SSH.** If your server has a copy of your repository:

```bash
ssh nas 'cd ~/code/my-app && git pull && ~/keel/keel functions deploy --project my-app'
```

**Use Studio's API.** Studio deploys functions with an HTTP API that you can call too. It's protected by the Studio login, so this script needs `KEEL_DASHBOARD_USERNAME` and `KEEL_DASHBOARD_PASSWORD` (store them as CI secrets) and network access to Studio's port:

```js
// deploy.mjs: node deploy.mjs hello
import fs from 'node:fs/promises'
import path from 'node:path'

const STUDIO = process.env.KEEL_STUDIO_URL // e.g. http://192.168.1.20:3000
const PROJECT = 'my-app'
const ROOT = 'supabase/functions'
const name = process.argv[2]

// Reads a folder into { "hello/index.ts": "source", ... }, like ./keel does.
async function collect(dir, prefix, files) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) await collect(path.join(dir, entry.name), rel, files)
    else files[rel] = await fs.readFile(path.join(dir, entry.name), 'utf8')
  }
  return files
}

const files = await collect(path.join(ROOT, name), name, {})
for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith('_')) await collect(path.join(ROOT, entry.name), entry.name, files)
}

// Studio's API needs this header on every request, and keeps the session in a cookie.
const headers = { 'X-Keel-Studio': '1', 'Content-Type': 'application/json' }
const login = await fetch(`${STUDIO}/api/login`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    username: process.env.KEEL_DASHBOARD_USERNAME,
    password: process.env.KEEL_DASHBOARD_PASSWORD,
  }),
})
if (!login.ok) throw new Error(`Sign-in failed: ${(await login.json()).message}`)
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

const res = await fetch(`${STUDIO}/api/projects/${PROJECT}/functions/${name}`, {
  method: 'PUT',
  headers: { ...headers, Cookie: cookie },
  body: JSON.stringify({ files, verify_jwt: true }),
})
console.log(res.status, await res.json()) // 200 { name: 'hello', version: 5 }
```

The Studio login has full control over every project, so treat these credentials like the service role key. Studio allows 10 failed sign-in attempts per 15 minutes from one address. An account with two-factor authentication needs a `code` with the password, which makes it a poor fit for CI; deploying with the Keel image and `KEEL_DB_URL` (above) needs no Studio account. The endpoints are described in the [API reference](/api/functions#management-api-studio).
