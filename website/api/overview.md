# Overview

Keel serves the same HTTP and WebSocket APIs as Supabase, one set per project, behind a single base URL. Most apps use them through `@supabase/supabase-js`. This reference documents the endpoints themselves, for other languages, for scripts and for debugging.

::: code-group

```js [JavaScript]
import { createClient } from '@supabase/supabase-js'

const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')
const { data, error } = await keel.from('todos').select('*')
```

```bash [curl]
curl 'http://localhost:8000/my-app/rest/v1/todos?select=*' \
  -H "apikey: YOUR_ANON_KEY"
```

:::

## Base URL

Every project has its own API URL: the gateway's address, followed by the project name.

```text
http://<server>:8000/<project>
```

For example, `http://localhost:8000/my-app`. The address part comes from `KEEL_PUBLIC_URL` (see [Configuration](/self-hosting/configuration)), and Studio's **Connect** panel shows the full URL. In this reference, endpoint paths are relative to the API URL: `/rest/v1/todos` means `http://localhost:8000/my-app/rest/v1/todos`.

Under the API URL are five services, at the same paths as on Supabase:

| Service | Path | What it does | Reference |
|---|---|---|---|
| REST | `/rest/v1/` | Read and write tables and views, call database functions | [REST (database)](/api/rest) |
| Auth | `/auth/v1/` | Sign-up, sign-in, sessions, users, MFA, admin | [Auth](/api/auth) |
| Storage | `/storage/v1/` | Buckets, files, signed URLs, resumable uploads, image transformations | [Storage](/api/storage) |
| Realtime | `/realtime/v1/` | WebSocket for database changes, broadcast and presence | [Realtime](/api/realtime) |
| Edge functions | `/functions/v1/<name>` | Your functions | [Edge functions](/api/functions) |

A request for a project that doesn't exist gets the same answer as a wrong API key (`401 Invalid API key`, or `No API key found in request` without one), so strangers can't find out which project names exist. Storage and edge function URLs, which don't need a key at the gateway, answer `404 Not found` instead.

## Authentication

Requests carry up to two credentials:

| Header | What it is |
|---|---|
| `apikey: YOUR_ANON_KEY` | The project's **anon** or **service role** key. It tells the gateway which kind of client is calling. It can also be sent as an `apikey` query parameter, which WebSocket clients need. |
| `Authorization: Bearer <token>` | Who the request is for: a signed-in user's **access token**, or one of the keys. It decides the Postgres role the request runs as, and what `auth.uid()` returns. |

Both keys and user tokens are JWTs signed with the project's own secret, so they only work for that project. The services check them like this:

| Service | `apikey` | `Authorization` |
|---|---|---|
| REST | Required | Optional. Without it, the request runs with the key's role (`anon` or `service_role`). |
| Auth | Required, except on the pages browsers open from emails and OAuth (`/verify`, `/callback`, `/authorize`) and `GET /settings` | A user's access token for `/user`, `/logout` and `/factors`; the service role key for `/admin/...` and `/invite` |
| Storage | Not checked by the gateway | A user's token or a key for most requests (storage falls back to the `apikey` header). Not needed for public files and signed URLs. |
| Realtime | Required, as the `apikey` query parameter of the WebSocket | A user's token goes in the channel join message instead (see [Realtime](/api/realtime)). |
| Edge functions | Not checked | Required unless the function has JWT verification off. Any valid token for the project works: the anon key, the service role key or a user's token. |

A signed-in request sends both: the anon key, and the user's access token from a sign-in.

```bash
curl 'http://localhost:8000/my-app/rest/v1/todos?select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

Access tokens expire after an hour by default; refresh them with `POST /auth/v1/token?grant_type=refresh_token`. See [Sessions and tokens](/auth/sessions).

## Which key for which job

| Job | Use |
|---|---|
| A browser or mobile app, before anyone signs in | The anon key |
| A browser or mobile app, for a signed-in user | The anon key plus the user's access token (client libraries send both for you) |
| A server script, cron job or back office tool | The service role key, which bypasses row level security |
| Creating, listing or deleting users (admin API) | The service role key |
| An edge function acting as the caller | `SUPABASE_ANON_KEY`, plus the caller's `Authorization` header passed on |
| An edge function that needs full access | `SUPABASE_SERVICE_ROLE_KEY` |
| A webhook from another service calling a function | No key: turn JWT verification off for that function and check the sender's signature in your code |
| Downloading from a public bucket | No key |
| Sharing a private file | A signed URL, which carries its own token |
| Migrations, ORMs and reporting tools | Not an API key: the Postgres connection string (see [Connecting directly](/database/connecting-directly)) |

::: danger
The service role key can read and change everything in the project. Never put it in a browser, a mobile app or a public repository.
:::

## Requests and responses

- **JSON in and out.** Send JSON bodies with `Content-Type: application/json`. Responses are JSON, except file downloads, transformed images and whatever your edge functions return.
- **REST** follows PostgREST's conventions: filters in the query string, and headers such as `Prefer: return=representation` (return the changed rows), `Prefer: count=exact` (include a total) and `Range` for paging. Responses are capped at 1,000 rows. See [REST (database)](/api/rest).
- **Uploads** send the file's bytes as the body with the file's content type, or as `multipart/form-data`. Resumable uploads use the TUS protocol. See [Storage](/api/storage).
- **IDs and times.** Users, files and sessions have UUIDs; timestamps are ISO 8601 strings.

## CORS

The gateway lets web pages on any origin call the API:

- It answers every preflight (`OPTIONS`) request itself with `204`, allowing any origin (`Access-Control-Allow-Origin: *`), the methods `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` and `HEAD`, and whatever request headers the browser asks for. Browsers may cache the answer for 24 hours.
- It adds `Access-Control-Allow-Origin: *` to every response and exposes the headers clients need to read, such as `Content-Range`, `ETag`, `Location` and the TUS `Upload-*` headers.
- Edge functions can set their own CORS headers; the gateway fills in its defaults only when a function doesn't. Preflight requests never reach your function.

What a caller may do is decided by keys, tokens and policies, not by the origin. To reach Keel from a site served over HTTPS, the API needs HTTPS too: see [Internet access and HTTPS](/self-hosting/remote-access).

## Versioning

All paths include `/v1`, like Supabase's. Keel tracks the APIs that the current `@supabase/supabase-js` v2 uses, so as long as your client library works with Supabase's v1 endpoints, it works with Keel. The REST API's shape comes from your own schema: new tables and columns appear as soon as you create them.

Keel's own version is shown in Studio under **Project settings**. Features that Supabase has and Keel doesn't are listed in [Supabase compatibility](/reference/compatibility).

## Errors

Errors use HTTP status codes, with a JSON body whose shape depends on the service, exactly as on Supabase:

| From | Example body |
|---|---|
| Gateway (unknown project, missing or wrong API key) | `{"message":"Invalid API key"}` |
| REST | `{"code":"42501","details":null,"hint":null,"message":"permission denied for table todos"}` |
| Auth | `{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}` |
| Storage | `{"statusCode":"404","error":"not_found","message":"Object not found"}` |
| Edge functions | `{"code":"NOT_FOUND","message":"Requested function was not found"}`, or whatever your function returns |

[Errors](/api/errors) lists the codes you're most likely to meet and what to do about them.

## curl or a client library?

Use a **client library** in apps. It sends the right headers, stores the session and refreshes tokens, and speaks the realtime protocol. The official Supabase clients take the same API URL and anon key; see [Connecting your app](/guide/connecting).

Use **plain HTTP** (curl, `fetch`, or any language's HTTP library) for quick checks, shell scripts, languages without a Supabase client, and debugging. Every endpoint in this reference has a curl example. For example, signing in and then reading data as that user:

```bash
curl -X POST 'http://localhost:8000/my-app/auth/v1/token?grant_type=password' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"a-long-password"}'
# copy access_token from the response, then:
curl 'http://localhost:8000/my-app/rest/v1/todos?select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

::: tip Working with a coding agent?
[Build with AI agents](/guide/ai-agents) explains how to give an AI assistant these docs and your project's details.
:::

## API reference

<div class="cards">
  <a class="card" href="./rest"><strong>REST (database)</strong><span>Tables, views, filters, embedding and RPC.</span></a>
  <a class="card" href="./auth"><strong>Auth</strong><span>Sign-up, sign-in, sessions, MFA and the admin API.</span></a>
  <a class="card" href="./storage"><strong>Storage</strong><span>Buckets, files, signed URLs and resumable uploads.</span></a>
  <a class="card" href="./realtime"><strong>Realtime</strong><span>The WebSocket protocol for changes, broadcast and presence.</span></a>
  <a class="card" href="./functions"><strong>Edge functions</strong><span>Calling your functions over HTTP and WebSockets.</span></a>
  <a class="card" href="./errors"><strong>Errors</strong><span>Error formats and the codes you're likely to see.</span></a>
</div>
