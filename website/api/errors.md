# Errors

Each Keel service answers errors in the same format as its Supabase counterpart, so supabase-js and the other client libraries understand them. This page lists the format of each service, the messages you're most likely to see and how to handle them in your app.

| Service | Error body | In supabase-js |
|---|---|---|
| Gateway | `{ "message": "..." }` | Surfaced by whichever client made the call |
| REST | `{ "code", "message", "details", "hint" }` | `PostgrestError` with `code`, `message`, `details`, `hint` |
| Auth | `{ "code", "error_code", "msg" }` | `AuthApiError` with `status`, `code` (the `error_code`) and `message` |
| Storage | `{ "statusCode", "error", "message" }` | `StorageApiError` with `status`, `statusCode` and `message` |
| Edge functions | `{ "code", "message" }` for Keel's own errors | `FunctionsHttpError` with the raw `Response` in `context` |
| Realtime | `phx_reply` with `"status": "error"`, or a `system` message | `CHANNEL_ERROR` in the `subscribe()` callback |

## HTTP status codes

| Status | What it usually means in Keel |
|---|---|
| `200`, `201`, `204` | Success |
| `300` | REST: the request is ambiguous, for example two possible relationships for an embed (`PGRST201`) or overloaded database functions (`PGRST203`) |
| `400` | The request is malformed or breaks a rule: bad query syntax, a missing field, a `not null` or `check` constraint, Auth validation. Storage also uses `400` for invalid tokens. |
| `401` | No valid credentials: missing or invalid API key, an invalid or expired access token, or a row level security denial for an anonymous request |
| `403` | Valid credentials, but not allowed: row level security denial for a signed-in user, an admin endpoint called without the service role key |
| `404` | Unknown table, database function, edge function, bucket, file or user (or project, for storage and functions URLs) |
| `405` | The method isn't supported for this endpoint |
| `406` | REST: `.single()` found zero or several rows (`PGRST116`) |
| `409` | Conflict: duplicate key, foreign key violation, a file that already exists |
| `413` | Too large: an upload over the file size limit, a function over 20 MB |
| `416` | REST: invalid range for pagination (`PGRST103`) |
| `422` | Auth: the request is understood but can't be done, for example the user already exists or the password is too weak |
| `429` | Auth: too many requests or emails; wait and retry |
| `500` | Unexpected error, or an edge function threw. Check the logs. |
| `502` | A Keel service or a function's process isn't responding |
| `503` | Something is starting or unavailable: a project's REST API right after it's created, a function that failed to start, image transformations |
| `504` | An edge function ran past its time limit |

## Gateway

Every request passes the gateway first. It checks the project and, for most services, the API key in the `apikey` header (or an `apikey` query parameter):

| Status | Body |
|---|---|
| `401` | `{ "message": "No API key found in request" }` |
| `401` | `{ "message": "Invalid API key" }` (also for a project that doesn't exist) |
| `401` | `{ "message": "API key has expired" }` |
| `404` | `{ "message": "Not found" }` (storage or functions URL of a project that doesn't exist) |
| `404` | `{ "message": "Not found. Project APIs live at /<project>/{rest,auth,storage,realtime,functions}/v1" }` |
| `502` | `{ "error": "bad_gateway", "message": "The service is not available right now" }` |

`Invalid API key` also means the key belongs to another project, or that a user's access token was sent as the API key: `apikey` only accepts the project's anon or service role key.

The key is required for REST, for Auth (except the browser redirect endpoints `/verify`, `/callback` and `/authorize`, and `/.well-known/...`) and for Realtime connections. A project that doesn't exist gets the same answer as a wrong key, so project names can't be guessed. Storage and edge functions don't need it at the gateway; they check tokens themselves. A `502` means the service behind the gateway is down: check it under **Logs** in Studio or with `./keel ps`.

## REST

The REST API is [PostgREST](https://postgrest.org) 12. Errors carry a Postgres error code (`SQLSTATE`) or a PostgREST code starting with `PGRST`:

```json
{
  "code": "23505",
  "details": "Key (email)=(ada@example.com) already exists.",
  "hint": null,
  "message": "duplicate key value violates unique constraint \"profiles_email_key\""
}
```

| `code` | Status | Meaning |
|---|---|---|
| `PGRST116` | `406` | `.single()` returned zero or several rows (`JSON object requested, multiple (or no) rows returned`; `details` says how many). Use `.maybeSingle()` when no row is a valid answer. |
| `PGRST301` | `401` | The access token is invalid or expired (`JWT expired`). supabase-js refreshes sessions automatically; this usually means the user was signed out. |
| `PGRST100` | `400` | The query string can't be parsed, for example a misspelled filter operator. |
| `PGRST200` | `400` | No relationship found for an embedded resource (`Could not find a relationship between 'todos' and 'users' in the schema cache`). |
| `PGRST202` | `404` | The database function called with `rpc()` doesn't exist or its arguments don't match. |
| `PGRST204` | `400` | A column in the request body doesn't exist (`Could not find the 'titel' column of 'todos' in the schema cache`). |
| `42501` | `401`, `403` | Permission denied, including `new row violates row-level security policy for table "todos"`. `401` for anonymous requests, `403` for signed-in users. |
| `23505` | `409` | Unique constraint violation (duplicate key). |
| `23503` | `409` | Foreign key violation: the referenced row doesn't exist, or other rows still reference this one. |
| `23502` | `400` | A required (`not null`) column is missing. |
| `22P02` | `400` | A value has the wrong type, such as text where a number or UUID is expected. |
| `42P01` | `404` | The table or view doesn't exist. |
| `42703` | `400` | A column in a filter or `select` doesn't exist. |
| `P0001` | `400` | Raised by your own SQL with `raise exception`. The `message` is yours. |

Row level security doesn't always produce an error: rows a user can't see are left out, so an `update` or `delete` that matches nothing the user may touch succeeds and changes nothing. Add `.select()` to see which rows were affected.

Right after a project is created, its REST API needs a moment to start and answers `503` with `{ "message": "The REST API for \"my-app\" is starting, try again in a moment." }` and a `Retry-After: 2` header.

The full list of PostgREST codes is in the [PostgREST documentation](https://docs.postgrest.org/en/v12/references/errors.html). See also [Querying with the API](/database/querying) and [Database functions](/database/functions).

## Auth

Auth errors use the GoTrue format, with the HTTP status repeated in `code`, a stable machine-readable `error_code` and a human-readable `msg`:

```json
{ "code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials" }
```

Some errors carry extra fields. A too-short password, for example, also includes `"weak_password": { "reasons": ["length"], "message": "..." }`.

| `error_code` | Status | When |
|---|---|---|
| `invalid_credentials` | `400` | Wrong email, phone or password |
| `email_not_confirmed` | `400` | Password sign-in before the email address is confirmed |
| `validation_failed` | `400` | A required field is missing or malformed |
| `refresh_token_not_found`, `refresh_token_already_used` | `400` | The refresh token is unknown, revoked or was already used: sign in again |
| `user_banned` | `400` | The user is banned |
| `no_authorization` | `401` | The endpoint needs a user's access token |
| `bad_jwt` | `403` | The access token is invalid, expired or has no user |
| `session_not_found` | `403` | The token's session has been signed out |
| `not_admin` | `403` | An admin endpoint called without the service role key |
| `otp_expired` | `403` | The code or link is wrong or has expired |
| `user_not_found` | `404` | No such user |
| `user_already_exists`, `email_exists`, `phone_exists` | `422` | The email address or phone number is taken |
| `weak_password` | `422` | The password is shorter than the project's minimum (or longer than 72 characters) |
| `signup_disabled` | `422` | New sign-ups are turned off for the project |
| `otp_disabled` | `422` | A magic link or code was requested for an unknown user while sign-ups are off, or with `shouldCreateUser: false` |
| `anonymous_provider_disabled` | `422` | Anonymous sign-ins are turned off |
| `insufficient_aal` | `401`, `422` | The action needs a session that passed two-factor authentication (`aal2`) |
| `mfa_verification_failed` | `422` | Wrong two-factor code |
| `over_request_rate_limit` | `429` | Too many attempts from this address or for this account |
| `over_email_send_rate_limit`, `over_sms_send_rate_limit` | `429` | Too many emails or text messages sent; the message says how long to wait |
| `unexpected_failure` | `500` | The mail server refused an email (`Error sending email`); the `keel-auth` log has the reason |

Errors in links that users open in the browser (email confirmation, magic links, password reset, OAuth sign-in) can't be shown as JSON. When the link has a `redirect_to`, Auth redirects there with the error in the URL fragment:

```text
https://app.example.com/welcome#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
```

Without a redirect address, the user sees a short error page instead. See the [Auth API reference](/api/auth) for each endpoint.

## Storage

Storage errors repeat the HTTP status as a string in `statusCode`, with a short `error` name and a `message`:

```json
{ "statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy" }
```

| Status | `error` | `message` | When |
|---|---|---|---|
| `400` | `Unauthorized` | `Invalid JWT` | The token is invalid or from another project |
| `400` | `Unauthorized` | `"exp" claim timestamp check failed` | The token has expired |
| `400` | `Unauthorized` | `headers must have required property 'authorization'` | No token on a request that needs one |
| `400` | `InvalidSignature` | `The url do not match the signature` | A signed URL was changed |
| `400` | `InvalidJWT` | `"exp" claim timestamp check failed` | A signed URL has expired |
| `403` | `Unauthorized` | `new row violates row-level security policy` | Your [storage policies](/storage/access-control) don't allow the upload or change |
| `404` | `Bucket not found` | `Bucket not found` | No such bucket |
| `404` | `not_found` | `Object not found` | No such file, or the policies hide it |
| `409` | `Duplicate` | `The resource already exists` | A file exists at that path; pass `upsert: true` to replace it |
| `409` | `InvalidRequest` | `The bucket you tried to delete is not empty` | Empty the bucket first |
| `413` | `Payload too large` | `The object exceeded the maximum allowed size` | The file is larger than the bucket's or server's limit |
| `503` | `transformation_unavailable` | `Image transformation service (keel-imgproxy) is not running` | Image resizing is down |

Resumable uploads add a few of their own, such as `410` (`expired`) for an upload that has expired. See the [Storage API reference](/api/storage).

## Edge functions

Responses from your function's code are passed through unchanged. Errors that Keel itself produces have a `code` and a `message`:

```json
{ "code": "WORKER_TIMEOUT", "message": "Function exceeded the 150s time limit" }
```

| Status | `code` | Cause |
|---|---|---|
| `401` | `401` | Missing or invalid JWT on a function with `verify_jwt` on |
| `404` | `NOT_FOUND` | No such function |
| `500` | `WORKER_ERROR` | The function threw an error |
| `502` | `WORKER_ERROR` or `BOOT_ERROR` | The function's process crashed, or `keel-functions` is down |
| `503` | `BOOT_ERROR` | The function failed to start |
| `504` | `WORKER_TIMEOUT` | The function ran past its time limit |

The exact messages are in the [Edge functions API reference](/api/functions#errors).

## Realtime

A WebSocket connection without a valid API key is refused during the handshake with an HTTP status and a body such as `{ "error": "Invalid API key" }`.

After connecting, a failed channel join comes back as a `phx_reply` with `status: "error"`:

```json
{
  "event": "phx_reply",
  "topic": "realtime:room:42",
  "payload": {
    "status": "error",
    "response": { "reason": "Unauthorized: You do not have permissions to read from this Channel topic: room:42" }
  }
}
```

| `reason` | Cause |
|---|---|
| `Invalid token: token has expired` | The user's access token expired. Other `Invalid token: ...` reasons mean the token is malformed or from another project. |
| `Unauthorized: You do not have permissions to read from this Channel topic: ...` | A [private channel](/realtime/authorization) whose policies on `realtime.messages` don't let this user read |
| `PrivateOnly: This project only allows private channels` | The project only allows private channels, and the channel wasn't created with `private: true` |

On a private channel, a broadcast or presence update the user may not send is answered with `Unauthorized: You do not have permissions to write to this Channel topic` or `... to track presence on this Channel topic`.

While a channel is open, Keel can also close it with a `system` message, for example when the access token expires:

```json
{ "event": "system", "payload": { "status": "error", "message": "Token has expired", "extension": "system", "channel": "room:42" } }
```

The HTTP broadcast endpoint answers `401` `{ "message": "Invalid token" }` or `400` `{ "message": "Invalid JSON body" }`. See the [Realtime API reference](/api/realtime).

## Handling errors in supabase-js

Every supabase-js call returns `{ data, error }` instead of throwing, so check `error` after each call:

```js
import { FunctionsHttpError } from '@supabase/supabase-js'

// REST
const { data: todo, error } = await keel.from('todos').insert({ task: 'Buy milk' }).select().single()
if (error) {
  if (error.code === '23505') showMessage('That todo already exists')
  else if (error.code === '42501') showMessage('You are not allowed to do that')
  else console.error(error.code, error.message, error.details, error.hint)
}

// Auth
const { error: signInError } = await keel.auth.signInWithPassword({ email, password })
if (signInError?.code === 'invalid_credentials') showMessage('Wrong email or password')
else if (signInError?.status === 429) showMessage('Too many attempts. Try again in a few minutes.')

// Storage
const { error: uploadError } = await keel.storage.from('avatars').upload(path, file)
if (uploadError) console.error(uploadError.status, uploadError.message)

// Edge functions: read the body your function (or Keel) returned
const { error: fnError } = await keel.functions.invoke('hello', { body: { name: 'Ada' } })
if (fnError instanceof FunctionsHttpError) {
  const body = await fnError.context.json()
  console.error(fnError.context.status, body.message)
}

// Realtime
keel
  .channel('room:42', { config: { private: true } })
  .on('broadcast', { event: 'message' }, (msg) => console.log(msg))
  .subscribe((status, err) => {
    if (status === 'CHANNEL_ERROR') console.error(err?.message)
  })
```
