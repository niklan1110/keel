# Sessions and tokens

Every sign-in creates a session: a short-lived access token that proves who the user is, and a refresh token that gets new access tokens. This page covers what's in them, how long they last, how sign-out works and how to check a token on your own server.

```js
const { data: { session } } = await keel.auth.getSession()

session.access_token   // JWT sent as "Authorization: Bearer ..." on every request
session.expires_at     // Unix time when it expires
session.refresh_token  // used by supabase-js to get the next access token
session.user           // the user object
```

## The session

Sign-in, sign-up (when no confirmation is needed), `verifyOtp`, MFA verification and refreshes all return the same shape:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1791025200,
  "refresh_token": "q3Vx9P0mJ8cS2bKfT7wLzY1nR4eH6aDo",
  "user": { "id": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b", "email": "ada@example.com", "...": "..." }
}
```

supabase-js keeps it in `localStorage` in browsers (give each client its own `storageKey` if a page talks to [several projects](/guide/connecting#several-projects-in-one-app)) and refreshes the access token before it expires.

## Access token claims

The access token is a JWT signed with the project's secret (HS256). Decoded, it looks like this:

```json
{
  "aud": "authenticated",
  "exp": 1791025200,
  "iat": 1791021600,
  "iss": "http://localhost:8000/my-app/auth/v1",
  "sub": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
  "email": "ada@example.com",
  "phone": "",
  "app_metadata": { "provider": "email", "providers": ["email"] },
  "user_metadata": { "display_name": "Ada" },
  "role": "authenticated",
  "aal": "aal1",
  "amr": [{ "method": "password", "timestamp": 1791021600 }],
  "session_id": "3f0c2a9e-5b7d-4e61-8a2f-9d4c1b7e6a50",
  "is_anonymous": false,
  "ref": "my-app"
}
```

| Claim | Meaning |
|---|---|
| `sub` | The user's ID. `auth.uid()` returns it in SQL. |
| `role` | The Postgres role requests run as, normally `authenticated` |
| `aud` | Always `authenticated` |
| `email`, `phone` | The user's email and phone (digits, no `+`), or an empty string |
| `app_metadata`, `user_metadata` | Copies of the user's metadata when the token was issued |
| `aal` | `aal1`, or `aal2` after [two-factor authentication](/auth/mfa) |
| `amr` | How this session was authenticated, newest first: `password`, `otp`, `magiclink`, `recovery`, `invite`, `oauth`, `anonymous`, `totp`, `mfa/phone` and others |
| `session_id` | The row in `auth.sessions` |
| `is_anonymous` | `true` for [anonymous users](/auth/anonymous) |
| `iss` | The project's auth URL, built from `KEEL_PUBLIC_URL` |
| `iat`, `exp` | Issued and expiry time (Unix seconds) |
| `ref` | The project name. Tokens are only accepted by the project that issued them. |

In SQL, read any claim with `auth.jwt()`, for example `auth.jwt() ->> 'aal'` or `auth.jwt() -> 'app_metadata' ->> 'role'`.

## Token lifetime

Access tokens last **3600 seconds** (one hour) by default. Change it in Studio under **Users** > **Sign-in settings** > **Session token lifetime (seconds)**, anywhere from 60 seconds to 7 days. The new lifetime applies to tokens issued after you save; tokens already out keep their expiry.

A shorter lifetime means signed-out or banned users lose access sooner (see [signing out](#signing-out)), at the cost of more refresh requests.

## Refresh tokens

- **Rotation.** Each refresh token works once. Refreshing returns a new access token and a new refresh token.
- **Reuse detection.** For 10 seconds after a refresh token is used, it still works, so two tabs refreshing at the same moment both succeed; the second one gets the session's current refresh token rather than a new one, so a session never has two valid tokens. After that, using it again counts as a stolen token: the refresh fails with `refresh_token_already_used` and the whole session is ended.
- **No fixed expiry.** Refresh tokens don't expire on a timer while they're used. A session lasts until the user signs out, changes their password (which ends their other sessions), is deleted or banned, a reused token ends it, or nobody refreshes it for 90 days. Sessions store the IP address and browser they were created from, so keel-auth deletes unused ones hourly, together with refresh tokens rotated more than 90 days ago; the user then signs in again. Keel has no setting for shorter inactivity timeouts or a maximum session length.
- **Fresh claims.** A refresh reloads the user, so changes to `app_metadata`, `user_metadata` or the email show up in the next access token. The session keeps its `aal` level.

Refresh by hand, for example right after changing a user's metadata on the server:

```js
const { data, error } = await keel.auth.refreshSession()
```

Refresh tokens are stored as SHA-256 hashes, so a copy of the database doesn't contain usable tokens. (Keel derives each token from its row and the project's internal secret, which is how it can hand out a session's current token again during the reuse window.)

## Signing out

```js
await keel.auth.signOut()                     // every session of this user (the default)
await keel.auth.signOut({ scope: 'local' })   // only this browser's session
await keel.auth.signOut({ scope: 'others' })  // every session except this one
```

| `scope` | Ends |
|---|---|
| `global` (default) | All of the user's sessions, on every device |
| `local` | The current session only |
| `others` | All sessions except the current one |

Signing out deletes the sessions and their refresh tokens at once, and `GET /auth/v1/user` rejects their access tokens right away (`session_not_found`). The REST, Storage and Realtime APIs only check a token's signature and expiry, though, so an access token that was already handed out keeps working there until it expires. That's the same as Supabase, and the reason to keep token lifetimes short.

Changing or resetting a password doesn't sign out other devices. Call `signOut({ scope: 'others' })` afterwards if it should. [Banning a user](/auth/managing-users) ends all of their sessions.

## getSession, getUser and getClaims

| Method | What it does | Trust it on a server? |
|---|---|---|
| `getSession()` | Reads the stored session, refreshing it if it has expired. No request when it's still valid. | No: it doesn't verify the token. |
| `getUser()` | Calls `GET /auth/v1/user`, which checks the signature, that the session still exists and that the user hasn't been deleted | Yes |
| `getClaims()` | Returns the token's claims after verifying it. Keel's tokens are signed with a shared secret (HS256) and its key set at `/.well-known/jwks.json` is empty, so supabase-js verifies them by calling `getUser()`. | Yes |

In the browser, `getSession()` is fine for showing the signed-in state. Anywhere a decision depends on the user, such as a server route or an edge function, use `getUser()`.

## Verifying tokens on your own server

The simplest way is to ask Keel. This also catches signed-out sessions:

::: code-group

```js [JavaScript]
const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const token = request.headers.get('Authorization')?.replace('Bearer ', '')
const { data: { user }, error } = await keel.auth.getUser(token)
if (error) return new Response('Unauthorized', { status: 401 })
```

```bash [curl]
curl http://localhost:8000/my-app/auth/v1/user \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN"
```

:::

You can also verify tokens locally, with no request, using the project's signing keys. Studio doesn't show them; read the active ones from Keel's control database:

```bash
./keel psql keel
```

```sql
select kid, secret from keel.project_jwt_keys
 where project = 'my-app' and (expires_at is null or expires_at > now())
 order by created_at desc;
```

Tokens name their key in the `kid` header field (tokens without one come from the key named `legacy`). Verify with any JWT library, for example [`jose`](https://github.com/panva/jose), and fetch the keys again after a [key roll](/guide/api-keys):

```js
import { jwtVerify } from 'jose'

// KEEL_JWT_KEYS: {"<kid>": "<secret>", ...} from the query above
const keys = JSON.parse(process.env.KEEL_JWT_KEYS)
const { payload } = await jwtVerify(
  token,
  (header) => new TextEncoder().encode(keys[header.kid ?? 'legacy']),
  { algorithms: ['HS256'], audience: 'authenticated' },
)
if (payload.ref !== 'my-app') throw new Error('Token is for another project')
// payload.sub is the user ID
```

::: danger Signing keys are master keys
Anyone with one can create a service role token for the project and read or change everything. Keep it on servers you control. Local verification also can't tell that a session was signed out; it trusts the token until `exp`.
:::

Edge functions check the JWT for you unless you turn that off. See [Auth and calling Keel](/functions/auth).

## Custom claims

Keel doesn't support auth hooks, so you can't run code that adds claims to the token. Two alternatives:

**Put the data in `app_metadata`.** Only the service role can change it, and it's copied into every access token:

```js
// On your server, with the service role key
await admin.auth.admin.updateUserById(userId, { app_metadata: { role: 'editor', team_id: 42 } })
```

```sql
create policy "Editors update articles" on articles for update to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'editor');
```

The new values appear in the user's next access token, at the latest after the current one expires; call `refreshSession()` in the app to get them sooner. Never use `user_metadata` for permissions: users can change it themselves.

**Look it up in a table.** A policy can query your own `user_roles` or `memberships` table instead. It's always current, at the cost of a query per check. See [row level security](/database/row-level-security).

## Server-side rendering

Server-rendered apps (Next.js, SvelteKit, Nuxt, Remix) can use [`@supabase/ssr`](https://supabase.com/docs/guides/auth/server-side) with Keel's API URL and anon key, as with Supabase. It keeps the session in cookies and uses the PKCE flow, which Keel supports for email links and sign-in with providers: the callback route receives `?code=` and calls `exchangeCodeForSession(code)`. On the server, check the user with `getUser()` rather than trusting the session in the cookie.
