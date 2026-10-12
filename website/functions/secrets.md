# Secrets

Secrets are environment variables for your functions: API keys, webhook signing secrets, passwords. You set them once per project, outside your code, and every function in the project reads them with `Deno.env.get()`.

```bash
./keel secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... --project my-app
```

```ts
const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
```

## Set secrets with the CLI

```bash
./keel secrets set NAME=value ... [--env-file FILE] [--project NAME]
./keel secrets list [--project NAME]
./keel secrets unset NAME ... [--project NAME]
```

`--project` defaults to `KEEL_DEFAULT_PROJECT` (`my-app`). Like `./keel functions deploy`, these commands run on the Keel server. From another computer, run them with the Keel image and `KEEL_DB_URL` (see [Deploying](/functions/deploying#deploy-from-another-computer-or-ci)). Each value can be up to 64 KB.

**From a file.** Values typed on the command line end up in your shell history, so for real keys, put them in a file and load it with `--env-file`:

```bash
# supabase/functions/.env  (keep it out of git)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
RESEND_API_KEY="re_..."
```

```bash
./keel secrets set --env-file supabase/functions/.env --project my-app
```

```text
Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY for my-app. Running functions restart with the new values.
```

The file uses `NAME=value` lines. Empty lines and lines starting with `#` are skipped, an `export ` prefix is removed, and quotes around the value are stripped. Everything after the `=` is the value, so don't put spaces around the `=` or comments at the end of a line.

**Listing.** `./keel secrets list` shows each name and when it was last set. Values are never printed:

```text
STRIPE_SECRET_KEY                        2026-10-02T17:01:00.000Z
STRIPE_WEBHOOK_SECRET                    2026-10-02T17:01:00.000Z
```

## Set secrets in Studio

1. Open **Functions** in the dock and click **Secrets**.
2. Under **Add or update**, type one `NAME=value` per line, or paste a whole `.env` file.
3. Click the save button. It counts what you entered, for example **Save 2 secrets**.

**Stored secrets** lists every secret with its last update and the first 12 characters of the value's SHA-256 hash, so you can check which value is set without revealing it:

```bash
printf %s 'sk_live_...' | sha256sum | cut -c1-12
```

The trash icon next to a secret deletes it. Studio, like the CLI, accepts values up to 64 KB.

## Read secrets in a function

```ts
const apiKey = Deno.env.get('RESEND_API_KEY')
if (!apiKey) throw new Error('RESEND_API_KEY is not set')
```

`Deno.env.get()` returns `undefined` for a secret that isn't set. Reading the variables once at the top of your module is fine: a function's process always restarts when secrets change (see [below](#when-changes-take-effect)).

## Names

Secret names use letters, digits and underscores, don't start with a digit, and are at most 128 characters long. Names are case-sensitive.

These names are reserved, because Keel sets them or because they would change how the runtime loads code, looks up names, makes connections or writes files. Setting one fails with `NAME is set by Keel and can't be overridden`. The check ignores case:

| Reserved | |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Set by Keel for every function |
| `KEEL_*` | Keel's own variables |
| `DENO_*`, `NODE_*` | Runtime settings |
| `LD_*`, `SSL_CERT_*` | Library loading and TLS certificates |
| `PATH`, `HOME`, `TMPDIR` | Process environment |
| `*_PROXY` (such as `HTTPS_PROXY`), `NPM_CONFIG_*` | Outgoing connections and package downloads |
| `SSLKEYLOGFILE`, `RUST_*`, `MALLOC_*`, `GLIBC_TUNABLES`, `GCONV_PATH`, `LOCPATH` | Files the runtime writes, and how it runs |
| `HOSTALIASES`, `RES_OPTIONS`, `LOCALDOMAIN` | Name lookups |

## Variables Keel sets

Every function gets these in addition to your secrets:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | The project's API URL **inside Keel**, for example `http://keel-gateway.invalid:8000/my-app` (a name that only works from function code). Requests to it from `fetch`, `supabase-js` or a WebSocket go to your project's API through a private socket. |
| `SUPABASE_ANON_KEY` | The project's anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | The project's service role key. It bypasses row level security. |
| `KEEL_URL` | Same as `SUPABASE_URL` |
| `KEEL_PUBLIC_URL` | The project's public API URL, built from `KEEL_PUBLIC_URL` in `.env`, for example `http://192.168.1.20:8000/my-app` |
| `KEEL_PROJECT` | The project's name, for example `my-app` |
| `TMPDIR`, `HOME` | The process's own temporary folder |
| `TZ` | The server's time zone, from `TZ` in `.env` |

If the `keel-functions` container has `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (in upper or lower case), `DENO_CERT` or `DENO_TLS_CA_STORE` set, functions get those too. The sandbox checks the connection to a proxy like any other, so a proxy on a private address is refused unless it's listed in [`KEEL_FUNCTIONS_ALLOW_LAN`](/functions/overview#allowing-addresses-on-your-network). Through a proxy, though, the proxy looks up the names in a function's requests, not the sandbox: a name that points at a private address (`192-168-1-20.nip.io`) gets through unless the proxy refuses private and link-local destinations itself. Only use a proxy that does.

::: tip Links for your users
`SUPABASE_URL` points at Keel's internal address, which is fast for calls from the function but unreachable from a browser (and from anything other than the function's own `fetch` and WebSockets). When a function hands out a URL, such as a signed download link or a public file URL, build it from `KEEL_PUBLIC_URL`. The [file export example](/functions/examples#export-a-table-to-a-csv-file) shows how.
:::

## Connecting to Postgres directly

Supabase sets `SUPABASE_DB_URL` for its functions. Keel doesn't, and a function can't connect to Keel's Postgres directly: the [sandbox](/functions/overview#network-access) refuses connections to private addresses, which include the database. Read and write through `supabase-js` instead, and put queries that don't fit the REST API into a [database function](/database/overview) that you call with `rpc()`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

Deno.serve(async () => {
  const { count } = await admin.from('todos').select('*', { count: 'exact', head: true })
  return Response.json({ total: count })
})
```

A database elsewhere on the internet can still be reached with a driver such as `npm:postgres`, using a connection string stored as a secret.

## When changes take effect

Changes apply right away, without a redeploy. When you set, change or remove a secret, Keel stops the project's running function processes as soon as they finish the requests they're handling. The next request to each function starts a fresh process with the new values. Functions that weren't running pick up the new values on their next start.

## How secrets are stored

- Secrets belong to a project. All functions in the project share them, and other projects can't read them.
- They're stored as plain text in Keel's control database (the `keel` database, table `keel.function_secrets`). Studio and the CLI never show values again after you save them, but anyone with the Postgres superuser password can read them.
- They aren't part of a project's [backups](/self-hosting/backups), and the [Supabase importer](/self-hosting/migrate-from-supabase) doesn't copy them. Keep your own copy, for example in a password manager or an untracked `.env` file.
