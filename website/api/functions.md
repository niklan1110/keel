# Edge functions

Deployed functions are served at `/functions/v1/{name}` under your project's API URL. Paths on this page are relative to the API URL (`http://localhost:8000/my-app`), except for the [management API](#management-api-studio) at the end, which Studio serves.

To write and deploy functions, start with the [Edge functions guide](/functions/overview).

## Invoke a function

### <code class="method post">ANY</code> /functions/v1/{name}

Runs the function `name` and returns its response. Every HTTP method is passed on (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and others), except `OPTIONS`, which the gateway answers itself (see below). Anything after the name is passed on as well: a request to `/functions/v1/hello/orders/42?expand=items` reaches the function with the path `/hello/orders/42?expand=items`.

| Name | Type | Description |
|---|---|---|
| `name` | path, **required** | The function's name. |
| `Authorization` | header | `Bearer <token>`. **Required** when the function has `verify_jwt` on (the default). Accepts the project's anon key, its service role key or a user's access token. |
| `apikey` | header | Not required for functions. Passed on to the function like other headers. |
| `Content-Type` | header | Whatever your function expects. supabase-js sets `application/json` for object bodies. |
| body | any | Streamed to the function unchanged. Keel sets no size limit. |

The function receives all request headers except hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`, `Proxy-Authorization`, `Proxy-Authenticate`). Keel adds:

| Header | Value |
|---|---|
| `X-Forwarded-For` | The chain of client addresses. The last entry is Keel's gateway; the one before it is the address that connected to the gateway. |
| `X-Forwarded-Host` | The `Host` the client used, such as `localhost:8000` |
| `X-Forwarded-Proto` | `http`, unless a reverse proxy in front of Keel already set it |

The `x-region` header and `forceFunctionRegion` query parameter that supabase-js sends when you pass `region` are passed on and otherwise ignored: Keel has one region, your server.

The response is your function's status, headers and body, streamed back as they're produced. When your response doesn't set them, the gateway adds `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods`, `Access-Control-Expose-Headers` and `Access-Control-Max-Age`.

::: code-group

```bash [curl]
curl -X POST 'http://localhost:8000/my-app/functions/v1/hello' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada"}'
```

```js [JavaScript]
const { data, error } = await keel.functions.invoke('hello', {
  body: { name: 'Ada' },
})
```

:::

```json
{ "message": "Hello Ada!" }
```

### <code class="method head">OPTIONS</code> /functions/v1/{name}

CORS preflight. The gateway answers it with `204 No Content` without calling the function:

| Response header | Value |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD` |
| `Access-Control-Allow-Headers` | The request's `Access-Control-Request-Headers`, or `authorization, apikey, content-type, x-client-info` when it has none |
| `Access-Control-Max-Age` | `86400` |

```bash
curl -i -X OPTIONS 'http://localhost:8000/my-app/functions/v1/hello' \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type'
```

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Max-Age: 86400
```

### <code class="method ws">WS</code> /functions/v1/{name}

Opens a WebSocket to a function that calls `Deno.upgradeWebSocket`. Use `ws://` (or `wss://` behind HTTPS). The JWT check works as for HTTP requests and reads only the `Authorization` header, which browsers can't set on WebSockets, so browser-facing WebSocket functions need `verify_jwt` off. When Keel refuses the upgrade, it answers with an HTTP status and a body like `{ "error": "Missing authorization header" }`.

```js
const ws = new WebSocket('ws://localhost:8000/my-app/functions/v1/echo')
```

## Errors

Errors produced by Keel (as opposed to your function) have this shape:

```json
{ "code": "NOT_FOUND", "message": "Requested function was not found" }
```

| Status | `code` | `message` |
|---|---|---|
| 401 | `401` | `Missing authorization header` |
| 401 | `401` | `Invalid JWT` |
| 404 | `NOT_FOUND` | `Requested function was not found` |
| 500 | `WORKER_ERROR` | `Function threw an error` |
| 502 | `WORKER_ERROR` | `Function stopped before responding (please check logs)` |
| 502 | `BOOT_ERROR` | `Edge functions are not running (keel-functions is unreachable)` |
| 503 | `BOOT_ERROR` | `Function failed to start (please check logs)` |
| 504 | `WORKER_TIMEOUT` | `Function exceeded the 150s time limit` (the number follows `KEEL_FUNCTIONS_TIMEOUT`) |

An unknown project returns `404` with `{ "message": "Not found" }` from the gateway. [Runtime and limits](/functions/runtime#errors-and-status-codes) explains the causes.

In supabase-js, any non-2xx response becomes a `FunctionsHttpError` whose `context` is the raw `Response`:

```js
import { FunctionsHttpError } from '@supabase/supabase-js'

const { data, error } = await keel.functions.invoke('hello', { body: { name: 'Ada' } })
if (error instanceof FunctionsHttpError) {
  const body = await error.context.json()
  console.error(error.context.status, body.message)
}
```

## Management API (Studio)

::: info Studio's own API
These endpoints are the ones Studio uses to deploy functions and manage secrets. They're served by Studio (`http://localhost:3000`), not by the gateway, so the paths below are relative to Studio's URL. They need a Studio session, which grants full control over every project. The API isn't versioned and may change between Keel releases. Use it for deploy scripts and CI; apps should never call it.
:::

Studio errors look like `{ "error": "invalid_function", "message": "Entrypoint hello/index.ts is not among the files" }`. A missing or expired session returns `401` with `"error": "unauthorized"`.

### <code class="method post">POST</code> /api/login

Signs in with a Studio account, such as the owner account from `KEEL_DASHBOARD_USERNAME` and `KEEL_DASHBOARD_PASSWORD`, and sets the session cookie `keel_studio_session` (HttpOnly, `SameSite=Strict`, valid for 12 hours). Send that cookie back on the other endpoints.

Every Studio API request, the sign-in included, needs the header `X-Keel-Studio: 1`, and requests from another web site are refused. That keeps other pages open in a browser from using your session.

| Name | Type | Description |
|---|---|---|
| `username` | string, **required** | Studio account name |
| `password` | string, **required** | Its password |
| `code` | string | The 6-digit code from the authenticator app, for an account with two-factor authentication. Without it, such an account gets `401` (`mfa_required`). |

Wrong credentials return `401` (`invalid_credentials`). After 10 failed attempts from one address within 15 minutes, sign-in returns `429` (`rate_limited`). A successful sign-in resets the count.

```bash
# -c saves the session cookie in keel-studio.txt; later calls send it with -b.
curl -X POST 'http://localhost:3000/api/login' -c keel-studio.txt \
  -H 'X-Keel-Studio: 1' \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_DASHBOARD_PASSWORD"}'
```

```json
{ "expiresAt": 1791118800, "username": "admin", "user": { "username": "admin", ... } }
```

### <code class="method get">GET</code> /api/projects/{project}/functions

Lists the project's functions with their running state.

```bash
curl 'http://localhost:3000/api/projects/my-app/functions' -b keel-studio.txt -H 'X-Keel-Studio: 1'
```

```json
{
  "runtime": "running",
  "baseUrl": "http://localhost:8000/my-app/functions/v1",
  "functions": [
    {
      "name": "hello",
      "entrypoint": "hello/index.ts",
      "verifyJwt": true,
      "version": 3,
      "createdAt": "2026-10-01T09:00:12.004Z",
      "updatedAt": "2026-10-03T09:14:51.330Z",
      "files": 2,
      "sizeBytes": 1342,
      "worker": { "state": "ready", "version": 3, "since": "2026-10-03T09:15:02.114Z", "inflight": 0 }
    }
  ]
}
```

`runtime` is `unreachable` when the `keel-functions` container isn't answering. `worker` is `null` when the function has no running process.

### <code class="method get">GET</code> /api/projects/{project}/functions/{name}

Returns one function with its source files.

```json
{
  "name": "hello",
  "entrypoint": "hello/index.ts",
  "verifyJwt": true,
  "version": 3,
  "files": {
    "hello/index.ts": "import { corsHeaders } from '../_shared/cors.ts'\n...",
    "_shared/cors.ts": "export const corsHeaders = { ... }\n"
  },
  "updatedAt": "2026-10-03T09:14:51.330Z"
}
```

### <code class="method put">PUT</code> /api/projects/{project}/functions/{name}

Creates the function or deploys a new version of it. The request body can be up to 25 MB.

| Name | Type | Description |
|---|---|---|
| `files` | object, **required** | Source files as `{ "path": "source" }`. Paths are relative to the functions folder, such as `hello/index.ts` and `_shared/cors.ts`. Text only; at most 500 files and 20 MB. The paths `.keel-complete` and `.keel/...` are reserved. |
| `entrypoint` | string | The file to run. Defaults to `{name}/index.ts` (or `.js`, `.tsx`, `.jsx`, `.mjs`, `.mts`). |
| `verify_jwt` | boolean | Require a valid JWT. Defaults to `true`, also when the function had it off before. |

```bash
curl -X PUT 'http://localhost:3000/api/projects/my-app/functions/hello' \
  -b keel-studio.txt -H 'X-Keel-Studio: 1' \
  -H 'Content-Type: application/json' \
  -d '{"files":{"hello/index.ts":"Deno.serve(() => new Response(\"hi\"))"},"verify_jwt":true}'
```

```json
{ "name": "hello", "version": 4 }
```

Invalid bundles return `400` (`invalid_function`) with messages such as `Entrypoint hello/index.ts is not among the files`, `Invalid file path: "../x.ts"` or `At most 500 files per function`, and `413` for `Function source is larger than 20 MB`. A name that isn't a valid function name returns `404`.

### <code class="method patch">PATCH</code> /api/projects/{project}/functions/{name}

Turns the JWT check on or off without deploying. Takes effect immediately.

| Name | Type | Description |
|---|---|---|
| `verify_jwt` | boolean, **required** | `true` to require a valid JWT, `false` to allow anyone |

```json
{ "verifyJwt": false }
```

### <code class="method delete">DELETE</code> /api/projects/{project}/functions/{name}

Deletes the function. It answers `404` from then on. Returns `{}`, or `404` if there was no such function.

### <code class="method get">GET</code> /api/projects/{project}/functions/{name}/logs

Returns the function's recent console output (up to 1,000 lines) and requests (up to 200), oldest first. `level` is `info`, `error` or `system` (Keel's own messages).

```json
{
  "logs": [
    { "t": "2026-10-03T09:15:02.114Z", "level": "system", "msg": "Starting v3" },
    { "t": "2026-10-03T09:15:02.541Z", "level": "info", "msg": "greeting Ada" }
  ],
  "invocations": [
    { "t": "2026-10-03T09:15:02.110Z", "method": "POST", "path": "/hello", "status": 200, "ms": 438 }
  ]
}
```

When `keel-functions` isn't answering, the lists are empty and the response includes `"unreachable": true`.

### <code class="method post">POST</code> /api/projects/{project}/functions/{name}/invoke

Studio's test runner: calls the function through the gateway, as an app would, and reports the result.

| Name | Type | Description |
|---|---|---|
| `method` | string | `GET`, `POST` (default), `PUT`, `PATCH` or `DELETE` |
| `path` | string | Sub-path and query string after the name, starting with `/` |
| `role` | string | `anon` (default) sends the anon key, `service_role` sends the service role key |
| `headers` | object | Extra request headers |
| `body` | string | Request body as a string (for JSON, a JSON-encoded string). Ignored for `GET` and `DELETE`. `Content-Type` defaults to `application/json`. |

```json
{
  "status": 200,
  "ms": 38,
  "headers": { "content-type": "application/json" },
  "body": "{\"message\":\"Hello Keel!\"}",
  "truncated": false
}
```

The response body is cut at 256 KB (`truncated: true`), and CORS headers are left out of `headers`.

### <code class="method get">GET</code> /api/projects/{project}/secrets

Lists the project's secrets. Values are never returned; `digest` is the first 12 hex characters of the value's SHA-256 hash.

```json
[
  { "name": "STRIPE_SECRET_KEY", "digest": "3f1c9a0b7d2e", "updatedAt": "2026-10-02T17:01:00.000Z" }
]
```

### <code class="method put">PUT</code> /api/projects/{project}/secrets

Adds or updates secrets. All of them are saved, or none if one is invalid. Running functions of the project restart with the new values.

| Name | Type | Description |
|---|---|---|
| `secrets` | object, **required** | `{ "NAME": "value" }`. Names use letters, digits and underscores and don't start with a digit; [reserved names](/functions/secrets#names) are refused. Values are text up to 64 KB. |

```bash
curl -X PUT 'http://localhost:3000/api/projects/my-app/secrets' \
  -b keel-studio.txt -H 'X-Keel-Studio: 1' \
  -H 'Content-Type: application/json' \
  -d '{"secrets":{"RESEND_API_KEY":"re_..."}}'
```

```json
{ "updated": ["RESEND_API_KEY"] }
```

### <code class="method delete">DELETE</code> /api/projects/{project}/secrets/{name}

Removes a secret. Returns `{}`, also when the secret didn't exist.
