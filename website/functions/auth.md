# Auth and calling Keel

Functions often need to know who's calling and to read or write your project's data. This page covers Keel's JWT check, reading the signed-in user, acting with the service role key, accepting webhooks from other services, and CORS.

## Require a valid JWT

Every function has a **Require a valid JWT** setting (`verify_jwt`), on by default. When it's on, Keel checks the request's `Authorization: Bearer <token>` header before your code runs. It accepts any unexpired token signed with one of the project's active [signing keys](/guide/api-keys):

- the project's **anon key**
- the project's **service role key**
- a **user's access token** from this project's Auth

Tokens from other projects, expired tokens and anything else are rejected with `401`:

| Request | Response |
|---|---|
| No `Authorization: Bearer` header | `401` `{ "code": 401, "message": "Missing authorization header" }` |
| Invalid, expired or other project's token | `401` `{ "code": 401, "message": "Invalid JWT" }` |

The `apikey` header isn't checked for functions; it's passed through to your code like any other header.

::: warning The JWT check doesn't identify the user
The anon key is public, so "has a valid JWT" means little more than "knows your project". If a function should only work for signed-in users, check the user in your code, as shown below.
:::

Turn the check off for functions that other services call, such as webhooks:

- in Studio, on the function's **Settings** tab
- with `./keel functions deploy <name> --no-verify-jwt`
- with `verify_jwt = false` under `[functions.<name>]` in `supabase/config.toml`

See [Deploying](/functions/deploying#turning-off-jwt-verification) for how these interact.

## Get the signed-in user

`keel.functions.invoke()` sends the signed-in user's access token in the `Authorization` header (or the anon key when nobody is signed in). In the function, pass that header on to a Keel client and ask Auth who it belongs to:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer /i, '')

  // A client that acts as the caller: row level security applies.
  const keel = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: { user } } = await keel.auth.getUser(token)
  if (!user) return Response.json({ message: 'Sign in first' }, { status: 401 })

  const { data: todos, error } = await keel.from('todos').select('id, task, done')
  if (error) return Response.json({ message: error.message }, { status: 500 })

  return Response.json({ email: user.email, todos })
})
```

`getUser()` asks Keel's Auth service, so it also rejects tokens whose session has been signed out. With the anon key instead of a user token, it returns no user.

On the app side there's nothing extra to do:

```js
const { data, error } = await keel.functions.invoke('my-todos', { method: 'GET' })
```

## Use the service role for admin work

The service role key bypasses row level security and unlocks the Auth admin API. Use it for work the caller isn't allowed to do directly, after you've checked that they should be allowed to ask:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL')!
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// "Delete my account": users can't delete themselves through the API.
Deno.serve(async (req) => {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return Response.json({ message: 'Sign in first' }, { status: 401 })

  await admin.from('todos').delete().eq('user_id', user.id)
  const { error } = await admin.auth.admin.deleteUser(user.id)
  if (error) return Response.json({ message: error.message }, { status: 500 })

  return Response.json({ deleted: user.id })
})
```

Keep two separate clients when you need both: don't add the caller's `Authorization` header to the admin client, or its requests run as the caller instead of the service role.

To make a function callable only by your own servers and scripts, compare the token with the service role key:

```ts
const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
if (token !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
  return Response.json({ message: 'Forbidden' }, { status: 403 })
}
```

## Webhooks from other services

Stripe, GitHub, payment providers and home-automation hubs can't send a Keel JWT. For these functions:

1. Turn **Require a valid JWT** off.
2. Verify the request yourself, usually with an HMAC signature computed from a shared secret.
3. Store that secret with [`./keel secrets set`](/functions/secrets).

Most providers ship a helper for step 2 (Stripe's is shown in the [Stripe example](/functions/examples#stripe-webhook)). For a plain HMAC-SHA256 signature, such as GitHub's `X-Hub-Signature-256`, Web Crypto is enough:

```ts
const encoder = new TextEncoder()
const key = await crypto.subtle.importKey(
  'raw',
  encoder.encode(Deno.env.get('GITHUB_WEBHOOK_SECRET')!),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['verify'],
)

Deno.serve(async (req) => {
  // Read the raw body: the signature covers the exact bytes that were sent.
  const body = await req.text()
  const hex = (req.headers.get('X-Hub-Signature-256') ?? '').replace(/^sha256=/, '')
  const signature = new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)))
  const valid = hex.length === 64 && (await crypto.subtle.verify('HMAC', key, signature, encoder.encode(body)))
  if (!valid) return new Response('Invalid signature', { status: 401 })

  const event = JSON.parse(body)
  console.log('GitHub event', req.headers.get('X-GitHub-Event'), event.repository?.full_name)
  return new Response('ok')
})
```

`crypto.subtle.verify` compares in constant time, so the check doesn't leak timing information.

A service on the internet can only reach your function if Keel is reachable from the internet, ideally over HTTPS. See [Internet access and HTTPS](/self-hosting/remote-access).

## CORS

Browsers send a *preflight* `OPTIONS` request before most cross-origin calls, and only let your page read the response if it carries the right `Access-Control-*` headers. On Keel, the gateway takes care of this for functions:

- It answers every `OPTIONS` request itself with `204`, allowing any origin, the headers the browser asks for, and the methods `GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD`. Browsers may cache that answer for 24 hours. **Your function never receives `OPTIONS` requests.**
- It adds `Access-Control-Allow-Origin: *` and the other CORS headers to your function's responses, unless your function sets them itself.

So functions on Keel don't need any CORS code. Functions written for Supabase usually include it, and it keeps working (the `OPTIONS` branch never runs on Keel), which keeps your code portable:

```ts
// supabase/functions/_shared/cors.ts
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
```

```ts
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Needed on Supabase. On Keel the gateway answers preflights before they get here.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const data = { hello: 'world' }
  return Response.json(data, { headers: corsHeaders })
})
```

To let only your own site read a function's responses in the browser, set `Access-Control-Allow-Origin` to that origin on every response, for example `'https://app.example.com'`. Keep in mind that the gateway's preflight answer still allows any origin, so the request itself reaches your function either way; the browser only hides the response from other sites. CORS isn't access control: protect functions with the JWT check, a user check or a signature.

## Calling Keel from a function

`SUPABASE_URL` points at Keel's gateway on the internal Docker network, so everything your app can do, a function can do too, without leaving the server:

| Task | How |
|---|---|
| Query tables, call RPCs | `keel.from('todos')...`, `keel.rpc('fn_name', args)` |
| Manage users | `admin.auth.admin.listUsers()`, `createUser()`, `deleteUser()` |
| Read and write files | `admin.storage.from('bucket').upload(...)`, `.download(...)` |
| Send a realtime broadcast | Send over HTTP without subscribing: `keel.channel('room').httpSend('ping', { at: Date.now() })` in recent supabase-js versions. See [Broadcast](/realtime/broadcast). |
| Call another function | `keel.functions.invoke('other-function', { body })` |

When you return a URL to the caller, build it from `KEEL_PUBLIC_URL`, not `SUPABASE_URL`: the internal address only works inside Keel. See [Variables Keel sets](/functions/secrets#variables-keel-sets).
