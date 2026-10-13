# Runtime and limits

Functions run on Deno 2 inside the `keel-functions` container, one process per function. This page covers the limits and how to change them, what happens on a cold start, which APIs are available, where logs go, and what each error response means.

## Limits

| Limit | Default | Setting in `.env` |
|---|---|---|
| Memory per function (JavaScript heap) | 256 MB | `KEEL_FUNCTIONS_MEMORY_MB` |
| Time per request, wall clock | 150 seconds | `KEEL_FUNCTIONS_TIMEOUT` |
| Idle time before a process stops | 300 seconds | `KEEL_FUNCTIONS_IDLE` |
| Function processes running at once, across all projects | 20 | `KEEL_FUNCTIONS_MAX_WORKERS` |
| Time to start, including first-time downloads | 90 seconds | `KEEL_FUNCTIONS_BOOT_TIMEOUT` |
| CPU time | No limit | |
| Request and response body size | No limit set by Keel | |
| Source per function | 500 files, 20 MB | |

Change a setting in `.env` and run `./keel up` to recreate the `keel-functions` container with it:

```bash
# .env
KEEL_FUNCTIONS_MEMORY_MB=512
KEEL_FUNCTIONS_TIMEOUT=300
```

- **Memory** caps the V8 heap of each function process. A function that needs more crashes with an out-of-memory error, and the request in progress gets a `502`. Separately from your code's own use, each running function adds about 40 MB to the server's memory use.
- **The time limit** covers the whole request, including streaming the response. When it runs out, the caller gets a `504`. WebSocket connections aren't limited.
- **Max processes** is a soft limit. When it's reached, Keel stops the least recently used *idle* function to make room. If every process is busy, the new one starts anyway.

## Lifecycle and cold starts

The first request to a function starts its process. Keel writes the function's files to disk (once per version), starts Deno, loads your module (downloading imports the first time) and waits for it to call `Deno.serve`. Then it forwards the request. Studio's **Logs** tab shows this as:

```text
KEEL  Starting v3
KEEL  Booted v3 in 412ms
```

Later requests go straight to the running process, and it handles several requests at the same time. Module-level variables, such as a database client or a cache, live as long as the process.

A process stops when:

| Reason | Logged as |
|---|---|
| No requests for `KEEL_FUNCTIONS_IDLE` seconds | `Stopping (idle)` |
| A new version was deployed | `Stopping (a new version was deployed)` |
| The project's secrets changed | `Stopping (its secrets changed)` |
| The function was deleted | `Stopping (the function was deleted)` |
| Room was needed for another function | `Stopping (making room for another function)` |
| The `keel-functions` container restarted | |

Except on a container restart, a stopping process first finishes the requests it's handling (for up to the time limit). The next request starts a fresh one. The function list in Studio shows each function as **Warm**, **Starting** or **Idle**.

Because processes come and go, never keep data only in memory. Use the database or Storage.

## Writing the handler

Keel runs the handler you pass to `Deno.serve`:

```ts
Deno.serve(async (req: Request) => {
  return new Response('ok')
})
```

- `Deno.serve(handler)`, `Deno.serve(options, handler)` and `Deno.serve({ handler })` all work, and so does a default export with a `fetch` method (`export default { fetch(req) { ... } }`).
- Options such as `port` and `hostname` are ignored, so `Deno.serve({ port: 8787 }, handler)` runs on port 8787 when you start it locally with `deno run` and unchanged on Keel. `onListen` is called, and `onError` is used for errors your handler throws.
- Call `Deno.serve` once. If you call it more than once, the last handler wins and a warning is logged.
- Older Supabase examples that import `serve` from `https://deno.land/std@<version>/http/server.ts` work too: Keel swaps in a compatible version, because the original doesn't run on Deno 2. This doesn't apply when the function has its own `deno.json` or import map.

The `Request` has the original method, headers and body. Its URL path is `/<function name>/...` with the query string, but its host is an internal Keel address, so use `KEEL_PUBLIC_URL` to build links (see [Secrets](/functions/secrets#variables-keel-sets)).

### Background work

`EdgeRuntime.waitUntil(promise)` keeps work going after you've sent the response, as on Supabase:

```ts
Deno.serve(async (req) => {
  const event = await req.json()
  EdgeRuntime.waitUntil(sendSlackNotification(event)) // runs after the response
  return Response.json({ ok: true })
})
```

Keel doesn't track this work when it stops a process: background tasks still running when the function goes idle, gets a new version or new secrets are cut off. Keep them short, and do anything that must not be lost before you respond. Errors in background tasks are logged.

## Available APIs

- **Web standard APIs:** `fetch`, `Request`, `Response`, `Headers`, `URL`, streams, `crypto` and `crypto.subtle`, `TextEncoder`, `Blob`, `FormData`, `WebSocket`, `AbortController`, timers.
- **Deno APIs** within the [sandbox](/functions/overview#the-sandbox): `Deno.env`, `Deno.upgradeWebSocket`, file APIs for the temp folder, `Deno.connect` for TCP.
- **Node.js compatibility:** `node:` built-ins and most `npm:` packages. Packages with native add-ons (such as `sharp`, `bcrypt` or `canvas`) can't load; use pure JavaScript or WebAssembly alternatives (`bcryptjs` instead of `bcrypt`).
- **TypeScript, JSX and TSX** run without a build step. Types aren't checked at runtime; run `deno check` locally.

These are blocked and throw `Deno.errors.NotCapable`:

- running programs (`Deno.Command`, `node:child_process`)
- native libraries (`Deno.dlopen`, Node add-ons)
- reading files outside the function's code, its temp folder and the package cache
- writing files outside the temp folder

## Files

The process's working directory is the root of your functions folder (the one that contains `hello/` and `_shared/`), and it's read-only. To read a file that you deployed next to your code, resolve it from the module's URL:

```ts
const template = await Deno.readTextFile(new URL('./welcome.html', import.meta.url))
```

For scratch files, use the temp folder. `TMPDIR` and `HOME` point at a folder that belongs to this process and is deleted when it stops:

```ts
const file = await Deno.makeTempFile({ suffix: '.csv' })
await Deno.writeTextFile(file, 'id,name\n1,Ada\n')
```

Keep anything you need later in [Storage](/storage/overview).

## Logs

Everything a function writes to the console is captured:

- `console.log`, `console.info` and `console.debug` show as `LOG`
- `console.error` and `console.warn` (standard error) show as `ERROR`
- Keel's own messages, such as starts, stops and boot errors, show as `KEEL`

**In Studio**, open the function and its **Logs** tab. It shows the last requests (status, method, path, duration) and the console output, refreshed every few seconds. Keel keeps the last 1,000 lines and the last 200 requests per function in memory, so they're cleared when the `keel-functions` container restarts. Lines longer than 4,000 characters are cut off.

**From the command line**, the same lines are in the container's log, tagged with the project and function:

```bash
./keel logs keel-functions
```

```text
2026-10-03T09:15:02.114Z INFO  [my-app/hello] Starting v1
2026-10-03T09:15:02.530Z INFO  [my-app/hello] Booted v1 in 416ms
2026-10-03T09:15:02.541Z INFO  [my-app/hello] greeting Ada
```

Studio's **Logs** dock item shows the same container log when you pick `keel-functions`. See [Logs and services](/studio/logs).

## Errors and status codes

When something goes wrong outside your code's control, Keel answers with a JSON body of the form `{ "code": ..., "message": ... }`:

| Status | `code` | `message` | Cause |
|---|---|---|---|
| 401 | `401` | `Missing authorization header` | JWT check on, no `Authorization: Bearer` header |
| 401 | `401` | `Invalid JWT` | JWT check on, token invalid, expired or from another project |
| 404 | `NOT_FOUND` | `Requested function was not found` | No function with that name in this project |
| 500 | `WORKER_ERROR` | `Function threw an error` | Your handler threw (and no `onError` handled it) |
| 502 | `WORKER_ERROR` | `Function stopped before responding (please check logs)` | The process exited mid-request, for example out of memory or `Deno.exit()` |
| 503 | `BOOT_ERROR` | `Function failed to start (please check logs)` | The function couldn't start (see below) |
| 504 | `WORKER_TIMEOUT` | `Function exceeded the 150s time limit` | The request ran past `KEEL_FUNCTIONS_TIMEOUT` |
| 502 | `BOOT_ERROR` | `Edge functions are not running (keel-functions is unreachable)` | The `keel-functions` container is down |

Responses your code returns, including its own `4xx` and `5xx`, are passed through unchanged. Keel never uses Supabase's `546` status.

When a function fails to start, its log says why:

| Log message | What to do |
|---|---|
| `Boot failed: the function could not be loaded (see the error above)` | A syntax error, a failed import or an exception at the top level of your module. The line above has the details. |
| `Boot failed: the function never called Deno.serve()` | Wrap your code in `Deno.serve(async (req) => { ... })`. |
| `Boot failed: did not start within 90s` | Usually slow or failing downloads of `npm:`/`jsr:` imports. Check that the server can reach the internet, or allow more time with `KEEL_FUNCTIONS_BOOT_TIMEOUT`. |

Errors thrown outside a request, such as an unhandled promise rejection in a timer, are logged and don't stop the process.

## Differences from Supabase Edge Functions

Most functions move between Supabase and Keel without changes. The differences:

| | Supabase | Keel |
|---|---|---|
| Isolation | Isolates on Supabase's edge runtime | One Deno process per function on your server |
| Limits | Fixed CPU time, memory and duration per plan | No CPU-time limit; memory and duration are [settings](#limits) |
| Regions | Choose with `x-region` or the `region` option | One server: the region is ignored |
| CORS preflight | Your function must answer `OPTIONS` | Keel's gateway answers `OPTIONS` and adds CORS headers ([details](/functions/auth#cors)) |
| `SUPABASE_URL` | Your project's public URL | Keel's internal address; use `KEEL_PUBLIC_URL` for public links |
| `SUPABASE_DB_URL` | Set for you | Not set; functions can't connect to Keel's Postgres directly ([why](/functions/secrets#connecting-to-postgres-directly)) |
| Network | Any address | The internet, your project's API and LAN addresses you allow; no other private or local addresses ([details](/functions/overview#network-access)) |
| `EdgeRuntime.waitUntil` | Supported, with a `beforeunload` event before shutdown | Supported; no shutdown event, see [background work](#background-work) |
| `Supabase.ai` (built-in embedding model) | Available | Not available |
| `config.toml` | `verify_jwt`, `entrypoint`, `import_map`, `static_files` | Only `verify_jwt` |
| Binary files in a function | With `static_files` | Not deployable; use Storage |
| Private npm registries (`.npmrc`) | Supported | Not supported (dot-files aren't deployed) |
| Logs | Searchable log explorer | Last 1,000 lines per function in Studio, plus the container log |
| Error status for resource limits | `546` | `502` (crash) or `504` (timeout) |
