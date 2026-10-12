# Overview

Edge functions are small TypeScript or JavaScript programs that run on your Keel server and answer HTTP requests. Use them for anything that shouldn't happen in the browser: receiving webhooks, taking payments, sending email, or calling another service with a secret API key.

Keel runs functions on [Deno](https://deno.com), like Supabase Edge Functions, so code written for Supabase usually works unchanged. A function is a folder with an `index.ts` that calls `Deno.serve`:

```ts
// supabase/functions/hello/index.ts
Deno.serve(async (req) => {
  const { name } = await req.json()
  return Response.json({ message: `Hello ${name}!` })
})
```

Each function gets a URL under your project, `http://localhost:8000/my-app/functions/v1/hello`, and you call it from your app with the client library:

```js
const { data, error } = await keel.functions.invoke('hello', { body: { name: 'Ada' } })
console.log(data.message) // "Hello Ada!"
```

## When to use a function

Reach for a function when the work needs a secret, a trusted environment or a service outside Keel:

| Use case | Why a function |
|---|---|
| **Webhooks** from Stripe, GitHub, a payment provider or a smart-home hub | Other services need a URL to call, and you need to check their signatures. |
| **Payments** | Creating a checkout session needs your payment provider's secret key. |
| **Email and notifications** | Sending through Resend, Postmark, an SMTP server or a push service needs credentials. |
| **Third-party APIs** | Keep API keys (OpenAI, weather, maps) on the server instead of in your app. |
| **Admin actions** | The service role key bypasses row level security, so it must never reach a browser. A function can check who's asking and then act with full access. |
| **Custom endpoints** | Combine several queries, validate input, or return a format the REST API doesn't produce. |

You often don't need one. Reading and writing tables from the browser is safe with the [REST API](/database/querying) and [row level security](/database/row-level-security). Logic that belongs next to your data can live in a [database function](/database/functions), and live updates come from [Realtime](/realtime/overview).

::: info No built-in scheduler
Keel doesn't run functions on a timer (there's no `pg_cron` or scheduled trigger yet). To run a job every night, call the function from cron or your NAS's task scheduler. See [Examples](/functions/examples).
:::

## How functions run

```text
 your app ──► gateway :8000 ──► keel-functions ──► Deno process for "hello"
              /my-app/functions/v1/hello           (started on the first request)
```

- **Deno 2.** The `keel-functions` container ships Deno 2 (version 2.9.7 in the current image) and a small supervisor that starts and stops function processes.
- **One process per function.** The first request to a function starts a Deno process for it (a *cold start*). Later requests reuse the running process, so it stays fast and keeps any module-level state, such as a database connection, between requests.
- **Stopped when idle.** A process stops after 5 minutes without requests (`KEEL_FUNCTIONS_IDLE`), when you deploy a new version, when the project's secrets change, or (if it's idle) to make room for another function when 20 are already running. The next request starts it again.
- **Your request, unchanged.** The function sees the method, headers, body and the path after `/functions/v1`, for example `/hello/orders/42?expand=items`. Whatever `Response` it returns goes back to the caller as is.

Limits, logs and lifecycle details are on [Runtime and limits](/functions/runtime).

## The sandbox

Each function process runs with a restricted set of Deno permissions:

| Capability | Allowed |
|---|---|
| Network: `fetch`, WebSockets, TCP connections | To the internet, and to your project's API through `SUPABASE_URL`. Not to private or local addresses (see below). |
| Environment variables (`Deno.env`) | Yes. The environment holds only your project's [secrets](/functions/secrets) and the variables Keel sets, such as `SUPABASE_URL`. |
| Reading files | Only the function's own code, its temporary folder and downloaded packages |
| Writing files | Only its temporary folder (`Deno.env.get('TMPDIR')`) |
| System information (`Deno.hostname()`, memory, CPU count) | Yes |
| Running programs (`Deno.Command`) | No |
| Native libraries (FFI, Node native addons) | No |

Anything outside these rules throws a `Deno.errors.NotCapable` error (for a host name, a `TypeError` whose `cause` says "Requires net access"). Functions never see Keel's own credentials, such as the Postgres password or `KEEL_SECRET`.

### Network access

A function can call any address on the internet. It can't connect to private or local addresses: `10.x`, `172.16.x` to `172.31.x`, `192.168.x`, `100.64.x` to `100.127.x` (Tailscale), `127.x` (`localhost`), `169.254.x` (cloud metadata) and the other reserved ranges. So it can't reach Keel's containers, the Docker host and its published ports (Studio, Postgres), your router or other devices on your network, under any name: the check is made on the address a name resolves to.

Your project's API is the exception. Requests to `SUPABASE_URL` (with `fetch`, `supabase-js` or a WebSocket) go through a private socket that leads only to your project's API, the same as a call from any other client. Calling another project's API that way is refused (403); use its public URL.

Two things that worked on a private network need another route:

- **Postgres:** a direct connection to `keel-db` is refused. Use `supabase-js` or a [database function](/database/overview) called with `rpc()`.
- **Services on your network,** such as a local Ollama or Home Assistant: list their addresses in `KEEL_FUNCTIONS_ALLOW_LAN` (see below).

`node:http` and other clients that don't use `fetch` can't use the `SUPABASE_URL` socket; use `fetch` or `supabase-js` for calls to your API.

### Allowing addresses on your network

To let functions call a device on your network, such as Ollama, Home Assistant or a NAS, list it in `.env` and recreate `keel-functions` (`./keel up`):

```bash
KEEL_FUNCTIONS_ALLOW_LAN=192.168.1.50:11434,192.168.1.60
```

- Entries are IPv4 addresses in `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or `100.64.0.0/10` (Tailscale), with an optional port, or ranges up to a `/24` such as `192.168.1.48/29`. Public addresses need no entry.
- **A port doesn't limit anything.** Deno can only open or close an address as a whole, so `192.168.1.50:11434` opens every port of `192.168.1.50`. Keel accepts the port to document your intent and logs a warning. List only devices whose other ports you'd also let function code reach.
- Ranges are only accepted when Keel knows this server's own LAN addresses (`KEEL_HOST_ADDRESSES`, which the installer and `./keel init` fill in), since a range almost always holds the machine Keel runs on. Those addresses stay closed inside an allowed range. Without the setting, list single addresses.
- Some addresses are never opened, whatever you list: this server (the Docker host, the addresses in `KEEL_HOST_ADDRESSES`, and `KEEL_PUBLIC_URL` or the Postgres host when they are IP addresses), Keel's containers and Docker networks, loopback, cloud metadata and anything in `KEEL_FUNCTIONS_DENY_NET`. Don't list the machine Keel runs on, under any address: its published ports include Studio and Postgres. Keel ignores entries it recognises as this server and logs why, but it can't know every address the machine has.
- Every function in every project can reach the listed addresses. Leave the setting empty (the default) to keep your whole network closed.

On a ZimaOS App Store install, add `KEEL_FUNCTIONS_ALLOW_LAN` (and `KEEL_HOST_ADDRESSES` with your NAS's address, for a range) to the `keel-functions` environment in the compose file.

::: warning Only deploy code you trust
A function holds your project's service role key and can call anything on the internet. Treat function code like any other server code: review what you deploy, especially packages you import.
:::

## What carries over from Supabase

- `Deno.serve` handlers, and the older `serve` from `deno.land/std/http/server.ts`
- `npm:`, `jsr:` and `https:` imports, `deno.json` and import maps
- Shared code in folders starting with `_`, such as `_shared`
- `verify_jwt`, per function, including `verify_jwt = false` in `supabase/config.toml`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` set for you
- `EdgeRuntime.waitUntil()` for work after the response
- WebSockets with `Deno.upgradeWebSocket`

The differences, such as how CORS is handled and what `config.toml` keys are read, are listed under [Runtime and limits](/functions/runtime#differences-from-supabase-edge-functions).

## Next steps

<div class="cards">
  <a class="card" href="./quickstart"><strong>Your first function</strong><span>Create, test and call a function in Studio or from your editor.</span></a>
  <a class="card" href="./deploying"><strong>Deploying</strong><span>Folder layout, the keel CLI, imports and versions.</span></a>
  <a class="card" href="./secrets"><strong>Secrets</strong><span>API keys and other environment variables for your functions.</span></a>
  <a class="card" href="./auth"><strong>Auth and calling Keel</strong><span>Check who's calling, use the service role, handle webhooks and CORS.</span></a>
  <a class="card" href="./examples"><strong>Examples</strong><span>Stripe webhooks, email, scheduled jobs, file exports, an LLM proxy and WebSockets.</span></a>
  <a class="card" href="./runtime"><strong>Runtime and limits</strong><span>Memory, timeouts, cold starts, logs and error responses.</span></a>
</div>
