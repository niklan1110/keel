# Core concepts

Five ideas explain almost everything in Keel: **projects**, the **gateway**, **API keys**, **user tokens** and **row level security**. They work the same way as in Supabase, so if you've used it before, this page is a quick refresher.

## Projects

A project is one app's backend. Each project has its own:

- **Postgres database** (the project `my-app` uses the database `my_app`)
- **API keys** and JWT secret
- **Users**, **files**, **edge functions** and **settings**

One Keel server can run many projects side by side, and they can't see each other's data: a key or user token from one project is rejected by every other project.

Create projects from the project switcher in Studio's header (**New project**). Names use lowercase letters, digits and dashes, start with a letter, end with a letter or digit, and are 3 to 40 characters long (see [Limits](/reference/limits#projects)). The first project, `my-app` by default, is created when Keel starts for the first time (set `KEEL_DEFAULT_PROJECT` to name it differently).

## The gateway and your API URL

All of your apps talk to one address, the **gateway** on port 8000. Each project lives under its own path:

```text
http://<server>:8000/<project>
```

This is the **API URL** that you pass to `createClient`. Below it are the five services, at the same paths as on Supabase:

| Path | Service | What it does |
|---|---|---|
| `/<project>/rest/v1/` | REST | Read and write tables, views and functions ([PostgREST](https://postgrest.org)) |
| `/<project>/auth/v1/` | Auth | Sign-up, sign-in, sessions and users |
| `/<project>/storage/v1/` | Storage | Buckets and files |
| `/<project>/realtime/v1/` | Realtime | WebSocket for changes, broadcast and presence |
| `/<project>/functions/v1/` | Functions | Your edge functions |

The address your apps use is set once in `KEEL_PUBLIC_URL` (for example `http://192.168.1.20:8000` or `https://api.example.com`). Keel uses it in emails, OAuth callbacks and signed URLs, and Studio's **Connect** panel shows the API URL built from it. See [Internet access and HTTPS](/self-hosting/remote-access) to reach Keel from outside your home.

## API keys

Each project has two keys. Both are JWTs signed with the project's secret, and you find them in Studio under **Connect**.

| Key | Postgres role | Where to use it |
|---|---|---|
| **anon** | `anon` | In browsers and mobile apps. It's public: anyone can extract it from your app. What it can read or write is decided by your row level security policies. |
| **service role** | `service_role` | Only on servers you control, edge functions and scripts. It **bypasses row level security** and can manage users. Never put it in a browser or app. |

Requests to the gateway send the key in the `apikey` header. Client libraries do this for you:

```js
const keel = createClient('http://localhost:8000/my-app', 'YOUR_ANON_KEY')
```

```bash
curl http://localhost:8000/my-app/rest/v1/todos -H "apikey: YOUR_ANON_KEY"
```

## User tokens

When a user signs in, Auth returns a **session**: a short-lived **access token** (a JWT, valid for one hour by default) and a **refresh token** to get new access tokens. The client library stores the session and sends the access token as `Authorization: Bearer <token>` on every request, refreshing it before it expires.

The access token carries claims that the rest of Keel uses:

```json
{
  "sub": "8d2b6f2e-0c1a-4f9e-9a63-5c0f1e2d3a4b",
  "role": "authenticated",
  "email": "ada@example.com",
  "aal": "aal1",
  "session_id": "…",
  "exp": 1767225600
}
```

- `sub` is the user's ID. In SQL, `auth.uid()` returns it.
- `role` is the Postgres role the request runs as: `authenticated` for signed-in users, `anon` for requests with only the anon key.
- `aal` is `aal2` once the user has passed [two-factor authentication](/auth/mfa).

Read more in [Sessions and tokens](/auth/sessions).

## Row level security

Your tables are reachable from browsers through the REST API, so something has to decide which rows each user may see and change. In Keel (as in Supabase) that's Postgres itself, through **row level security** (RLS) policies:

```sql
create policy "Users read their own notes" on notes
  for select to authenticated
  using (user_id = auth.uid());
```

Every API request runs as a Postgres role (`anon`, `authenticated` or `service_role`) with the user's token available to SQL, so the same policies apply to the REST API, realtime change streams and, through `storage.objects`, to files.

::: tip Safe by default
Keel switches RLS on for every new table in the `public` schema. Until you add a policy, a new table can't be read or written with the anon key or a user token. The service role key still has full access.
:::

The [row level security guide](/database/row-level-security) has the patterns you'll need most: owner-only rows, public read, team membership and MFA-only data.

## Studio

Studio, on port 3000, is the admin dashboard. It's separate from your apps: it has its own accounts (the first one is `KEEL_DASHBOARD_USERNAME` and `KEEL_DASHBOARD_PASSWORD` from `.env`), with optional two-factor authentication, and full access to every project. Use it to design tables, run SQL, manage users and files, deploy functions, read logs and take backups. See the [Studio tour](/studio/tour).

## Putting it together

When the browser runs `keel.from('notes').select('*')`:

1. The client sends `GET /my-app/rest/v1/notes?select=*` with the anon key in `apikey` and the user's access token in `Authorization`.
2. The gateway checks that the key belongs to `my-app` and forwards the request to the project's REST server.
3. PostgREST verifies the access token, switches to the `authenticated` role and makes the token's claims available to SQL.
4. Postgres runs the query and the policy filters it to rows where `user_id = auth.uid()`.
5. The rows come back as JSON.


## Next steps

<div class="cards">
  <a class="card" href="./connecting"><strong>Connecting your app</strong><span>API URL, keys and client libraries for every platform.</span></a>
  <a class="card" href="../database/row-level-security"><strong>Row level security</strong><span>Policy patterns for owner-only rows, public reads and teams.</span></a>
  <a class="card" href="../auth/overview"><strong>Auth</strong><span>Every way your users can sign in.</span></a>
</div>
